import { Logger } from '@nestjs/common';
import { ExamPart, ExamSessionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { getTiming } from '../cbtSessions/exam-spec';

/**
 * Shared MCQ (written-section) scoring used by BOTH:
 *   • GradingService.submit — the normal candidate submission path
 *   • gradeTerminatedWrittenSection — auto-scoring after a forced termination
 *
 * Kept as plain functions (prisma passed in) so cbtSessions/adminMonitor can
 * call the terminated-path scorer without importing GradingModule and
 * creating a Nest module cycle.
 */

export interface WrittenAnswerLike {
  id: string;
  questionId: string;
  selectedChoice: string | null;
  contentSnapshot: Prisma.JsonValue | null;
}

export interface WrittenBankRow {
  id: string;
  correctAnswer: string | null;
  subjectIndex: number;
  subjectName: string;
  points: number;
}

export interface WrittenScoringOutcome {
  perAnswer: { answerId: string; correct: boolean; earned: number }[];
  subjectAgg: Map<number, { name: string; earned: number; total: number }>;
  writtenEarned: number;
  writtenTotal: number;
  writtenPct: number;
}

/**
 * Pure MCQ scoring: grades each answer against the per-session shuffled
 * correct key (contentSnapshot.correctAnswerKey) with a fallback to the
 * question bank's original correctAnswer, aggregating per subject. Answers
 * whose question is missing from the bank are skipped (mirrors submit).
 */
export function computeWrittenScoring(
  answers: readonly WrittenAnswerLike[],
  bankById: ReadonlyMap<string, WrittenBankRow>,
): WrittenScoringOutcome {
  const subjectAgg = new Map<number, { name: string; earned: number; total: number }>();
  const perAnswer: WrittenScoringOutcome['perAnswer'] = [];
  let writtenEarned = 0;
  let writtenTotal = 0;

  for (const a of answers) {
    const q = bankById.get(a.questionId);
    if (!q) continue;

    // Use correctAnswerKey from contentSnapshot if available (handles shuffled choices)
    // Otherwise fall back to original correctAnswer from question bank
    const snapshot = a.contentSnapshot as { correctAnswerKey?: string } | null;
    const correctKey = snapshot?.correctAnswerKey ?? q.correctAnswer;
    const correct = a.selectedChoice != null && a.selectedChoice === correctKey;

    const earned = correct ? q.points : 0;
    writtenEarned += earned;
    writtenTotal += q.points;
    perAnswer.push({ answerId: a.id, correct, earned });

    const agg = subjectAgg.get(q.subjectIndex) ?? { name: q.subjectName, earned: 0, total: 0 };
    agg.earned += earned;
    agg.total += q.points;
    subjectAgg.set(q.subjectIndex, agg);
  }

  const writtenPct = writtenTotal > 0 ? Math.round((writtenEarned / writtenTotal) * 100) : 0;
  return { perAnswer, subjectAgg, writtenEarned, writtenTotal, writtenPct };
}

const terminatedScoringLogger = new Logger('TerminatedWrittenScoring');

/**
 * Auto-grade the MCQ written section of a force-terminated session so the
 * admin "unfinished exam" queue shows the written score without any manual
 * step. Policy: MCQ is machine-graded immediately at termination; practical/
 * essay answers stay saved and are ONLY AI-graded when an admin explicitly
 * clicks "Grade the exam" (ai-prescore). The session remains TERMINATED —
 * no pass/fail is derived and no certificate can ever be issued from it.
 *
 * Idempotent (skips when writtenScore is already set) and never throws —
 * every caller fires it post-commit and a scoring failure must not affect
 * the termination itself.
 */
export async function gradeTerminatedWrittenSection(
  prisma: PrismaService,
  sessionId: string,
): Promise<void> {
  try {
    const session = await prisma.examSession.findUnique({
      where: { id: sessionId },
      include: { answers: true },
    });
    if (!session || session.status !== ExamSessionStatus.TERMINATED) return;
    if (session.writtenScore != null) return;
    if (session.answers.length === 0) return;

    const bank = await prisma.questionBank.findMany({
      where: { id: { in: session.answers.map((a) => a.questionId) } },
      select: { id: true, correctAnswer: true, subjectIndex: true, subjectName: true, points: true },
    });
    const bankById = new Map(bank.map((q) => [q.id, q]));
    const scored = computeWrittenScoring(session.answers, bankById);
    const subjectFailPct = getTiming(session.certType, session.level).subjectFailPct;

    await prisma.$transaction(async (tx) => {
      for (const pa of scored.perAnswer) {
        await tx.answer.update({
          where: { id: pa.answerId },
          data: { isCorrect: pa.correct, earnedPoints: pa.earned },
        });
      }
      await tx.gradingResult.deleteMany({ where: { sessionId, part: ExamPart.WRITTEN } });
      const rows: Prisma.GradingResultCreateManyInput[] = [];
      for (const [idx, agg] of scored.subjectAgg) {
        const pct = agg.total > 0 ? Math.round((agg.earned / agg.total) * 100) : 0;
        rows.push({
          sessionId,
          part: ExamPart.WRITTEN,
          subjectIndex: idx,
          subjectName: agg.name,
          earned: agg.earned,
          total: agg.total,
          percentage: pct,
          subjectFailed: pct < subjectFailPct,
        });
      }
      if (rows.length > 0) await tx.gradingResult.createMany({ data: rows });
      await tx.examSession.update({
        where: { id: sessionId },
        data: { writtenScore: scored.writtenPct },
      });
    });

    terminatedScoringLogger.log(
      JSON.stringify({ msg: 'terminated_written_scored', sessionId, writtenPct: scored.writtenPct }),
    );
  } catch (err) {
    terminatedScoringLogger.warn(
      `terminated written scoring failed for session ${sessionId}: ${(err as Error).message}`,
    );
  }
}

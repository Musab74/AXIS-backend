import { Injectable, Logger } from '@nestjs/common';
import { ExamPart, ExamSessionStatus, Prisma, TaskTemplate } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { computeWeightedResult, getScoring, getTiming } from '../cbtSessions/exam-spec';
import { CertificatesService } from '../certificates/certificates.service';
import { EssayGradingService } from './essay-grading.service';

type SessionWithEssays = Prisma.ExamSessionGetPayload<{ include: { essayAnswers: true } }>;

/** Cap on how long submit waits for AI prescore before deferring L3 to the expert queue. */
const PRESCORE_TIMEOUT_MS = 10_000;

/**
 * L3-with-practicals auto-finalize on submit (운영기획서 §10).
 *
 * After the MCQ auto-grade, the submit path calls this to await the AI prescore
 * (timeout-safe) and, when the AI is confident (mandatoryReview=false) and every
 * practical task was scored, GRADE the session in the same request using the
 * shared weighted-100 math. Otherwise the session stays SUBMITTED for the expert
 * queue and the background prescore keeps running past the timeout.
 */
@Injectable()
export class L3AutoFinalizeService {
  private readonly logger = new Logger(L3AutoFinalizeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly essayGrading: EssayGradingService,
    private readonly certificates: CertificatesService,
  ) {}

  /** Returns true iff the session was auto-finalized to GRADED in this request. */
  async tryFinalizeOnSubmit(
    sessionId: string,
    tasks: TaskTemplate[],
    writtenPct: number,
  ): Promise<boolean> {
    const outcome = await this.racePrescore(sessionId);
    if (outcome !== 'done') {
      this.logger.log(JSON.stringify({ msg: 'l3_autofinalize_deferred', sessionId, reason: outcome }));
      return false;
    }

    // Re-read now that prescore has written aiPreScore/earnedPoints + mandatoryReview.
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      include: { essayAnswers: true },
    });
    if (!session) return false;

    const allScored =
      session.essayAnswers.length > 0 && session.essayAnswers.every((a) => a.earnedPoints != null);
    if (session.mandatoryReview || !allScored) {
      this.logger.log(
        JSON.stringify({
          msg: 'l3_autofinalize_skipped',
          sessionId,
          mandatoryReview: session.mandatoryReview,
          allScored,
        }),
      );
      return false;
    }

    await this.gradeGraded(session, tasks, writtenPct);
    return true;
  }

  /** Await prescore, but never hold the submit response longer than the timeout. */
  private async racePrescore(sessionId: string): Promise<'done' | 'timeout' | 'error'> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), PRESCORE_TIMEOUT_MS);
    });
    // On timeout the prescore promise keeps running (it writes scores in the
    // background); the attached handlers prevent an unhandled rejection.
    const run = this.essayGrading
      .aiPrescoreSession(sessionId)
      .then<'done'>(() => 'done')
      .catch((err): 'error' => {
        this.logger.warn(`AI prescore failed for session ${sessionId}: ${(err as Error).message}`);
        return 'error';
      });
    const outcome = await Promise.race([run, timeout]);
    if (timer) clearTimeout(timer);
    return outcome;
  }

  private async gradeGraded(
    session: SessionWithEssays,
    tasks: TaskTemplate[],
    writtenPct: number,
  ): Promise<void> {
    const earnedByTask = new Map(session.essayAnswers.map((a) => [a.taskId, a.earnedPoints ?? 0]));
    let earned = 0;
    let total = 0;
    for (const t of tasks) {
      total += t.points;
      earned += earnedByTask.get(t.id) ?? 0;
    }
    const practicalPct = total > 0 ? Math.round((earned / total) * 100) : 0;

    const scoring = getScoring(session.certType, session.level);
    const sectionPct = (part: ExamPart): number => (part === ExamPart.WRITTEN ? writtenPct : practicalPct);
    const { total: totalScore, passed, floorFailures } = computeWeightedResult(scoring, sectionPct);
    const failReason = passed ? null : buildFailReason(scoring.passTotal, sectionPct, floorFailures, totalScore);
    const subjectFailPct = getTiming(session.certType, session.level).subjectFailPct;

    await this.prisma.$transaction(async (tx) => {
      await tx.gradingResult.deleteMany({
        where: {
          sessionId: session.id,
          part: { in: [ExamPart.PRACTICAL, ExamPart.DELIVERABLE, ExamPart.ESSAY] },
        },
      });
      const rows: Prisma.GradingResultCreateManyInput[] = tasks.map((t, idx) => {
        const e = earnedByTask.get(t.id) ?? 0;
        const pct = t.points > 0 ? Math.round((e / t.points) * 100) : 0;
        return {
          sessionId: session.id, part: t.part, subjectIndex: idx, subjectName: t.title,
          earned: e, total: t.points, percentage: pct, subjectFailed: pct < subjectFailPct,
        };
      });
      if (rows.length) await tx.gradingResult.createMany({ data: rows });
      await tx.examSession.update({
        where: { id: session.id },
        data: { status: ExamSessionStatus.GRADED, practicalScore: practicalPct, totalScore, passed, failReason },
      });
      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: 'L3_AUTO_FINALIZED',
          entityType: 'ExamSession',
          entityId: session.id,
          after: { writtenPct, practicalPct, totalScore, passed } as Prisma.InputJsonValue,
        },
      });
    });

    if (passed) {
      await this.certificates
        .issueForSession(session.id)
        .catch((err) =>
          this.logger.error(`Certificate issuance failed for session ${session.id}: ${(err as Error).message}`),
        );
    }
    this.logger.log(
      JSON.stringify({ msg: 'l3_auto_finalized', sessionId: session.id, writtenPct, practicalPct, totalScore, passed }),
    );
  }
}

function buildFailReason(
  passTotal: number,
  sectionPct: (part: ExamPart) => number,
  floorFailures: ExamPart[],
  totalScore: number,
): string {
  const parts = floorFailures.map((p) => `${p} below section minimum (${sectionPct(p)}%).`);
  if (totalScore < passTotal) parts.push(`Total below ${passTotal} (${totalScore}/100).`);
  return parts.join(' ');
}

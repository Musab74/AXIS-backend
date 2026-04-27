import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ExamPart, ExamSessionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { LEVEL_TIMING } from '../cbtSessions/exam-spec';

@Injectable()
export class GradingService {
  constructor(private readonly prisma: PrismaService) {}

  async submit(userId: string, sessionId: string) {
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      include: { answers: true, essayAnswers: true },
    });
    if (!session) throw new NotFoundException();
    if (session.userId !== userId) throw new ForbiddenException();
    if (session.status === ExamSessionStatus.GRADED || session.status === ExamSessionStatus.SUBMITTED) {
      return this.getResult(userId, sessionId);
    }
    if (session.status !== ExamSessionStatus.IN_PROGRESS) throw new BadRequestException('Exam not in progress');

    const questionIds = session.answers.map((a) => a.questionId);
    const bank = await this.prisma.questionBank.findMany({
      where: { id: { in: questionIds } },
      select: { id: true, correctAnswer: true, subjectIndex: true, subjectName: true, points: true },
    });
    const bankById = new Map(bank.map((q) => [q.id, q]));

    const subjectAgg = new Map<number, { name: string; earned: number; total: number }>();
    let writtenEarned = 0;
    let writtenTotal = 0;

    for (const a of session.answers) {
      const q = bankById.get(a.questionId);
      if (!q) continue;
      const correct = a.selectedChoice != null && a.selectedChoice === q.correctAnswer;
      const earned = correct ? q.points : 0;
      writtenEarned += earned;
      writtenTotal += q.points;
      const agg = subjectAgg.get(q.subjectIndex) ?? { name: q.subjectName, earned: 0, total: 0 };
      agg.earned += earned;
      agg.total += q.points;
      subjectAgg.set(q.subjectIndex, agg);
      await this.prisma.answer.update({
        where: { id: a.id },
        data: { isCorrect: correct, earnedPoints: earned },
      });
    }

    const writtenPct = writtenTotal > 0 ? Math.round((writtenEarned / writtenTotal) * 100) : 0;

    const tasks = await this.prisma.taskTemplate.findMany({
      where: { certType: session.certType, level: session.level },
    });
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const practicalTotal = tasks.reduce((s, t) => s + t.points, 0);
    let practicalEarned = 0;
    const practicalSubjectAgg = new Map<ExamPart, { earned: number; total: number }>();

    for (const t of tasks) {
      const ans = session.essayAnswers.find((e) => e.taskId === t.id);
      const placeholder = scorePlaceholder(ans?.contentText ?? '', t.points);
      practicalEarned += placeholder;
      const agg = practicalSubjectAgg.get(t.part) ?? { earned: 0, total: 0 };
      agg.earned += placeholder;
      agg.total += t.points;
      practicalSubjectAgg.set(t.part, agg);
      if (ans) {
        await this.prisma.essayAnswer.update({
          where: { id: ans.id },
          data: { aiPreScore: placeholder, earnedPoints: placeholder, aiRationale: 'Placeholder grading: word-count heuristic.' },
        });
      } else if (t) {
        await this.prisma.essayAnswer.create({
          data: {
            sessionId,
            taskId: t.id,
            part: t.part,
            contentText: '',
            version: 1,
            aiPreScore: 0,
            earnedPoints: 0,
            aiRationale: 'No submission.',
          },
        });
      }
    }
    const practicalPct = practicalTotal > 0 ? Math.round((practicalEarned / practicalTotal) * 100) : null;

    await this.prisma.gradingResult.deleteMany({ where: { sessionId } });
    const subjectFailPct = LEVEL_TIMING[session.level].subjectFailPct;
    let anySubjectFailed = false;
    const gradingRows: Prisma.GradingResultCreateManyInput[] = [];
    for (const [idx, agg] of subjectAgg) {
      const pct = agg.total > 0 ? Math.round((agg.earned / agg.total) * 100) : 0;
      const failed = pct < subjectFailPct;
      if (failed) anySubjectFailed = true;
      gradingRows.push({
        sessionId,
        part: ExamPart.WRITTEN,
        subjectIndex: idx,
        subjectName: agg.name,
        earned: agg.earned,
        total: agg.total,
        percentage: pct,
        subjectFailed: failed,
      });
    }
    let pi = 0;
    for (const [part, agg] of practicalSubjectAgg) {
      const pct = agg.total > 0 ? Math.round((agg.earned / agg.total) * 100) : 0;
      gradingRows.push({
        sessionId,
        part,
        subjectIndex: pi++,
        subjectName: part === ExamPart.PRACTICAL ? 'AI hands-on tasks' : part === ExamPart.DELIVERABLE ? 'Part A — Deliverable' : 'Part B — Essay',
        earned: agg.earned,
        total: agg.total,
        percentage: pct,
        subjectFailed: false,
      });
    }
    await this.prisma.gradingResult.createMany({ data: gradingRows });

    const timing = LEVEL_TIMING[session.level];
    const writtenPassed = writtenPct >= timing.passWritten && !anySubjectFailed;
    const practicalPassed = timing.passPractical == null || (practicalPct ?? 0) >= timing.passPractical;
    const passed = writtenPassed && practicalPassed;
    const failReasonParts: string[] = [];
    if (anySubjectFailed) failReasonParts.push('A subject scored below 40%.');
    if (!writtenPassed && !anySubjectFailed) failReasonParts.push(`Written below ${timing.passWritten}% (${writtenPct}%).`);
    if (timing.passPractical != null && !practicalPassed) failReasonParts.push(`Practical below ${timing.passPractical}% (${practicalPct}%).`);

    await this.prisma.examSession.update({
      where: { id: sessionId },
      data: {
        status: ExamSessionStatus.GRADED,
        submittedAt: new Date(),
        writtenScore: writtenPct,
        practicalScore: practicalPct,
        totalScore: timing.passPractical == null ? writtenPct : Math.round((writtenPct + (practicalPct ?? 0)) / 2),
        passed,
        failReason: failReasonParts.join(' ') || null,
      },
    });

    return this.getResult(userId, sessionId);
  }

  async getResult(userId: string, sessionId: string) {
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      include: { gradingResults: { orderBy: [{ part: 'asc' }, { subjectIndex: 'asc' }] } },
    });
    if (!session) throw new NotFoundException();
    if (session.userId !== userId) throw new ForbiddenException();
    return {
      id: session.id,
      certType: session.certType,
      level: session.level,
      status: session.status,
      submittedAt: session.submittedAt,
      writtenScore: session.writtenScore,
      practicalScore: session.practicalScore,
      totalScore: session.totalScore,
      passed: session.passed,
      failReason: session.failReason,
      breakdown: session.gradingResults,
    };
  }
}

function scorePlaceholder(text: string, max: number): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  const ratio = Math.min(1, words / 80);
  return Math.round(max * (0.4 + ratio * 0.5));
}

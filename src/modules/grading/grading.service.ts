import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ExamPart, ExamSessionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { getTiming } from '../cbtSessions/exam-spec';
import { AdminMonitorGateway } from '../adminMonitor/admin-monitor.gateway';
import { AdminNotificationsService } from '../adminNotifications/admin-notifications.service';
import { ExamSessionPauseService } from '../adminMonitor/exam-session-pause.service';
import { CertificatesService } from '../certificates/certificates.service';
import { CbtSessionsService } from '../cbtSessions/cbt-sessions.service';
import { assertRegistrationActiveForSession } from '../cbtSessions/registration-active-guard';
import { EssayGradingService } from './essay-grading.service';

@Injectable()
export class GradingService {
  private readonly logger = new Logger(GradingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminMonitor: AdminMonitorGateway,
    private readonly notifications: AdminNotificationsService,
    private readonly certificates: CertificatesService,
    private readonly cbtSessions: CbtSessionsService,
    private readonly essayGrading: EssayGradingService,
    private readonly pause: ExamSessionPauseService,
  ) {}

  async submit(userId: string, sessionId: string) {
    await this.pause.assertNotPaused(sessionId);
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
    await assertRegistrationActiveForSession(this.prisma, session.registrationId);

    // Reject submit if the hard deadline has already passed — the client
    // auto-submits when time is up; a late server call means the candidate
    // delayed submission on purpose after the deadline.
    if (session.hardDeadline && new Date() > session.hardDeadline) {
      throw new BadRequestException('Submission deadline has passed. The exam has expired.');
    }

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
      
      // Use correctAnswerKey from contentSnapshot if available (handles shuffled choices)
      // Otherwise fall back to original correctAnswer from question bank
      const snapshot = a.contentSnapshot as { correctAnswerKey?: string } | null;
      const correctKey = snapshot?.correctAnswerKey ?? q.correctAnswer;
      const correct = a.selectedChoice != null && a.selectedChoice === correctKey;
      
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

    // Grade only the practical tasks selected for THIS session (the set
    // pre-created as EssayAnswer rows at start), not the whole task bank.
    const sessionTaskIds = Array.from(new Set(session.essayAnswers.map((e) => e.taskId)));
    const tasks = sessionTaskIds.length
      ? await this.prisma.taskTemplate.findMany({ where: { id: { in: sessionTaskIds } } })
      : [];

    const hasPractical = tasks.length > 0;

    // Practical / essay answers are NOT auto-scored.
    // They are stored as submitted and marked for manual or AI review.
    // Only the MCQ written section is machine-graded immediately.
    for (const t of tasks) {
      const ans = session.essayAnswers.find((e) => e.taskId === t.id);
      if (ans) {
        await this.prisma.essayAnswer.update({
          where: { id: ans.id },
          data: {
            aiPreScore: null,
            earnedPoints: null,
            aiRationale: 'AI 1차 채점 대기 중 / Pending AI first-pass + expert review.',
          },
        });
      } else {
        await this.prisma.essayAnswer.create({
          data: {
            sessionId,
            taskId: t.id,
            part: t.part,
            contentText: '',
            version: 1,
            aiPreScore: null,
            earnedPoints: null,
            aiRationale: 'No submission.',
          },
        });
      }
    }

    await this.prisma.gradingResult.deleteMany({ where: { sessionId } });
    const subjectFailPct = getTiming(session.certType, session.level).subjectFailPct;
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

    if (hasPractical) {
      // Add placeholder grading rows so the result breakdown shows tasks as pending
      let pi = 0;
      for (const t of tasks) {
        gradingRows.push({
          sessionId,
          part: t.part,
          subjectIndex: pi++,
          subjectName: t.title,
          earned: 0,
          total: t.points,
          percentage: 0,
          subjectFailed: false,
        });
      }
    }

    await this.prisma.gradingResult.createMany({ data: gradingRows });

    const timing = getTiming(session.certType, session.level);

    if (hasPractical) {
      // Practical requires human/AI review — session is SUBMITTED, not GRADED.
      // L1/L2 pass/fail is decided at finalize on the weighted 100-pt total
      // (LEVEL_SCORING), so we do NOT assert a written threshold here — the MC
      // score is advisory until the practical sections are scored.
      await this.prisma.examSession.update({
        where: { id: sessionId },
        data: {
          status: ExamSessionStatus.SUBMITTED,
          submittedAt: new Date(),
          writtenScore: writtenPct,
          practicalScore: null,
          totalScore: null,
          passed: null,
          failReason: 'Practical section pending review.',
        },
      });

      // Kick off the AI first-pass grade in the background. It writes advisory
      // scores onto the EssayAnswer rows for the grading queue; a human still
      // finalizes. Fire-and-forget — the submission has already committed and
      // an AI failure must never block the candidate (degrades to no-op when
      // ANTHROPIC_API_KEY is absent).
      void this.essayGrading
        .aiPrescoreSession(sessionId)
        .catch((err) =>
          this.logger.warn(`AI prescore failed for session ${sessionId}: ${(err as Error).message}`),
        );
    } else {
      // L3 — written only; grade immediately.
      const writtenPassed = writtenPct >= timing.passWritten && !anySubjectFailed;
      const passed = writtenPassed;
      const failReasonParts: string[] = [];
      if (anySubjectFailed) failReasonParts.push('A subject scored below 40%.');
      else if (!writtenPassed) failReasonParts.push(`Written below ${timing.passWritten}% (${writtenPct}%).`);

      await this.prisma.examSession.update({
        where: { id: sessionId },
        data: {
          status: ExamSessionStatus.GRADED,
          submittedAt: new Date(),
          writtenScore: writtenPct,
          practicalScore: null,
          totalScore: writtenPct,
          passed,
          failReason: failReasonParts.join(' ') || null,
        },
      });

      if (passed) {
        await this.certificates.issueForSession(sessionId);
      }
    }

    void this.adminMonitor.emitSessionUpdate({
      sessionId,
      status: 'submitted',
      progressPct: 100,
      warnings: session.proctorWarnings,
      candidateName: '',
      examName: `${session.certType.replace('_', '-')} ${session.level}`,
    });
    void this.adminMonitor.broadcastLiveStatus();

    const candidate = await this.prisma.user.findUnique({
      where: { id: session.userId },
      select: { name: true },
    });
    const examName = `${session.certType.replace('_', '-')} ${session.level}`;
    void this.notifications.notify({
      category: 'EXAM_FINISH',
      titleKo: '시험 제출 완료',
      titleEn: 'Exam submitted',
      bodyKo: `${candidate?.name ?? '응시자'}님이 ${examName} 시험을 제출했습니다.`,
      bodyEn: `${candidate?.name ?? 'Candidate'} submitted the ${examName} exam.`,
      severity: 'INFO',
      href: '/monitoring',
      meta: { sessionId },
    });

    // After a submission lands the candidate has either burned an attempt
    // (L2/L1 → SUBMITTED awaiting practical) or finished the exam outright
    // (L3 → GRADED with pass/fail). Re-evaluate the registration: if the
    // candidate has now passed (L3 immediate pass) OR exhausted all 3
    // attempts, flip the registration to EXAM_COMPLETED so it drops off the
    // candidate's "active exams" list and further entry attempts are
    // blocked. Fire-and-forget — the grading transaction already committed
    // and a registration-close failure must never void the candidate's
    // submission.
    void this.cbtSessions.closeRegistrationIfFinished(
      session.registrationId ?? null,
      sessionId,
      'submit',
    );

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
      // L3 with the 실습형 wire-up active also waits on expert review now, so
      // surface the same ETA hint we show L1/L2 candidates when passed is still
      // pending. Sessions on the legacy MCQ-only L3 path land as GRADED and
      // never reach this branch (passed is already true/false).
      practicalResultEtaDays:
        session.passed === null &&
        (session.level === 'L2' || session.level === 'L1' || session.level === 'L3')
          ? 14
          : null,
    };
  }
}

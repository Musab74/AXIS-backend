import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExamSessionStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { ExamSessionPauseService } from '../adminMonitor/exam-session-pause.service';
import { MonitorHeartbeatService } from '../adminMonitor/monitor-heartbeat.service';
import { assertIdentityVerifiedForSession } from '../cbtSessions/exam-identity-guard';
import { getTiming } from '../cbtSessions/exam-spec';

@Injectable()
export class CbtExamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly heartbeat: MonitorHeartbeatService,
    private readonly pause: ExamSessionPauseService,
    private readonly config: ConfigService,
  ) {}

  async getPaper(userId: string, sessionId: string) {
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      include: {
        answers: { orderBy: { orderIndex: 'asc' } },
        essayAnswers: true,
      },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.userId !== userId) throw new ForbiddenException();
    if (session.status === ExamSessionStatus.CREATED) throw new BadRequestException('Session not started');

    await assertIdentityVerifiedForSession(
      this.prisma,
      this.config.get<boolean>('cbt.skipIdentityCheck') === true,
      userId,
      sessionId,
    );

    if (session.status === ExamSessionStatus.IN_PROGRESS) {
      void this.heartbeat.markAlive(sessionId);
    }

    const timerPaused = await this.pause.isPaused(sessionId);

    // Deliver ONLY the practical tasks selected for this session at start time
    // (one coherent set, tracked by the pre-created EssayAnswer rows) — never
    // the whole task bank. L3 has no essay rows, so this is naturally empty.
    const essayByTaskId = new Map(session.essayAnswers.map((e) => [e.taskId, e]));
    const tasks = session.essayAnswers.length
      ? await this.prisma.taskTemplate.findMany({
          where: { id: { in: session.essayAnswers.map((e) => e.taskId) } },
          orderBy: [{ part: 'asc' }, { orderIndex: 'asc' }],
        })
      : [];

    const timing = getTiming(session.certType, session.level);
    return {
      session: {
        id: session.id,
        certType: session.certType,
        level: session.level,
        status: session.status,
        startedAt: session.startedAt,
        hardDeadline: session.hardDeadline,
        timing,
        timerPaused,
      },
      questions: session.answers.map((a) => {
        const snap = a.contentSnapshot as { stem: string; choices: { key: string; text: string }[]; subjectName: string; points: number };
        return {
          questionId: a.questionId,
          orderIndex: a.orderIndex,
          stem: snap.stem,
          choices: snap.choices,
          subjectName: snap.subjectName,
          points: snap.points,
          selectedChoice: a.selectedChoice,
          flagged: a.flagged,
          version: a.version,
        };
      }),
      tasks: tasks.map((t) => {
        const essay = essayByTaskId.get(t.id);
        return {
          taskId: t.id,
          part: t.part,
          title: t.title,
          scenario: t.scenario,
          durationMin: t.durationMin,
          points: t.points,
          orderIndex: t.orderIndex,
          // Instructional context from the authored practical CSV.
          sampleData: t.sampleData,
          requiredStructure: t.requiredStructure,
          forbiddenRules: t.forbiddenRules,
          aiToolAllowed: t.aiToolAllowed,
          // Saved progress so a reload/resume restores the candidate's work
          // and the correct optimistic-concurrency version (parity with MCQ).
          contentText: essay?.contentText ?? '',
          aiChatLog: essay?.aiChatLog ?? null,
          version: essay?.version ?? 0,
        };
      }),
    };
  }

  async saveAnswer(
    userId: string,
    sessionId: string,
    body: { questionId: string; selectedChoice?: string | null; flagged?: boolean; version: number },
  ) {
    void this.heartbeat.markAlive(sessionId);
    await this.pause.assertNotPaused(sessionId);
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.examSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new NotFoundException();
      if (session.userId !== userId) throw new ForbiddenException();
      if (session.status !== ExamSessionStatus.IN_PROGRESS) throw new BadRequestException('Exam not in progress');
      if (session.hardDeadline && new Date() > session.hardDeadline) throw new BadRequestException('Time over');

      const answer = await tx.answer.findUnique({
        where: { sessionId_questionId: { sessionId, questionId: body.questionId } },
      });
      if (!answer) throw new NotFoundException('Question not in this paper');
      if (answer.version !== body.version) {
        throw new ConflictException({ message: 'Version mismatch', currentVersion: answer.version });
      }
      const updated = await tx.answer.update({
        where: { id: answer.id },
        data: {
          selectedChoice: body.selectedChoice ?? null,
          flagged: body.flagged ?? answer.flagged,
          version: { increment: 1 },
        },
      });
      return { questionId: body.questionId, version: updated.version };
    });
  }
}

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExamSessionStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { ExamSessionPauseService } from '../adminMonitor/exam-session-pause.service';
import { MonitorHeartbeatService } from '../adminMonitor/monitor-heartbeat.service';
import { assertIdentityVerifiedForSession } from '../cbtSessions/exam-identity-guard';
import { assertRegistrationActiveForSession } from '../cbtSessions/registration-active-guard';
import { getTiming, toSpecVersion } from '../cbtSessions/exam-spec';
import { isSessionAiAllowed } from '../cbtPractical/cbt-practical.service';
import { ExamTranslationService } from '../../integrations/anthropic/exam-translation.service';
import { l3ClientView } from './l3-client-view';

@Injectable()
export class CbtExamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly heartbeat: MonitorHeartbeatService,
    private readonly pause: ExamSessionPauseService,
    private readonly config: ConfigService,
    private readonly translation: ExamTranslationService,
  ) {}

  async getPaper(userId: string, sessionId: string) {
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      include: {
        answers: { orderBy: { orderIndex: 'asc' } },
        essayAnswers: true,
        user: { select: { id: true, userId: true } },
      },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.userId !== userId) throw new ForbiddenException();
    if (session.status === ExamSessionStatus.CREATED) throw new BadRequestException('Session not started');

    await assertRegistrationActiveForSession(this.prisma, session.registrationId);

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

    const specVersion = toSpecVersion(session.specVersion);
    const timing = getTiming(session.certType, session.level, specVersion);
    const paper = {
      session: {
        id: session.id,
        certType: session.certType,
        level: session.level,
        status: session.status,
        specVersion,
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
        // L3 실습형 structured-answer spec. ONLY the answer-free fields
        // (practiceType / responseFormat / choices / fixedAiOutput) reach the
        // exam client — the rubric's answerKey and criterion points are never
        // serialized (they are the grading ground truth). See l3ClientView.
        const l3 = t.part === 'PRACTICAL' ? l3ClientView(t.rubric) : null;
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
          // 시험 표준 v2.0: 내장 AI는 L2에서만 — L1(전면 금지)·L3(도구 없음)
          // 세션에는 과제의 원본 정책과 무관하게 'AI 사용 불가'로 마스킹해
          // 프런트의 채팅 패널을 원천 차단한다 (서버 askAi 게이트와 동일 규칙).
          aiToolAllowed: isSessionAiAllowed(specVersion, session.level)
            ? t.aiToolAllowed
            : 'AI 사용 불가',
          // L3 실습형 answer-free structured-answer spec (null for L1/L2 or legacy L3).
          l3,
          // Saved progress so a reload/resume restores the candidate's work
          // and the correct optimistic-concurrency version (parity with MCQ).
          contentText: essay?.contentText ?? '',
          aiChatLog: essay?.aiChatLog ?? null,
          version: essay?.version ?? 0,
        };
      }),
    };

    // QA/TEST ONLY: render the paper in English for the single ENGLISH_TEST_USER.
    // Never touches real candidates; degrades to Korean if translation fails.
    if (this.translation.isEnglishTestUser(session.user)) {
      await this.translatePaperToEnglish(paper);
    }
    return paper;
  }

  /** Collect the candidate-facing strings, translate once (batched), write back. */
  private async translatePaperToEnglish(paper: {
    questions: { stem: string; choices: { key: string; text: string }[] }[];
    tasks: {
      title: string;
      scenario: string;
      requiredStructure?: string | null;
      l3: {
        practiceType: string | null;
        fields?: { label: string; options?: string[]; choices?: { code: string; text: string }[] }[];
      } | null;
    }[];
  }): Promise<void> {
    const strs: string[] = [];
    const setters: ((v: string) => void)[] = [];
    const add = (v: string | null | undefined, set: (v: string) => void) => {
      if (v && v.trim()) { strs.push(v); setters.push(set); }
    };
    for (const q of paper.questions) {
      add(q.stem, (v) => (q.stem = v));
      for (const c of q.choices) add(c.text, (v) => (c.text = v));
    }
    for (const t of paper.tasks) {
      add(t.title, (v) => (t.title = v));
      add(t.scenario, (v) => (t.scenario = v));
      add(t.requiredStructure ?? undefined, (v) => (t.requiredStructure = v));
      if (t.l3) {
        add(t.l3.practiceType ?? undefined, (v) => t.l3 && (t.l3.practiceType = v));
        for (const f of t.l3.fields ?? []) {
          add(f.label, (v) => (f.label = v));
          if (f.options) f.options.forEach((o, i) => add(o, (v) => f.options && (f.options[i] = v)));
          // v3: translate the option TEXT only. `code` (E1/T2/V4…) is the grading
          // key the client submits back — translating it would break scoring.
          if (f.choices) f.choices.forEach((c) => add(c.text, (v) => (c.text = v)));
        }
      }
    }
    if (strs.length === 0) return;
    const translated = await this.translation.toEnglish(strs);
    translated.forEach((v, i) => setters[i](v));
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
      await assertRegistrationActiveForSession(this.prisma, session.registrationId);

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

// The L3 render spec is a pure function — see ./l3-client-view. Re-exported here
// because callers (and tests) have always imported it from this module.
export { l3ClientView } from './l3-client-view';
export type { L3Field, L3Option, L3ClientView } from './l3-client-view';

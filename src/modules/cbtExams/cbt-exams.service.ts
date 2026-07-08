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
    return {
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

/**
 * One structured-answer input on the L3 실습형 form. `key` is the answerKey field
 * name the grader scores against (so the client's `selects` align exactly); it is
 * an identifier, NOT a correct value. `options` (when present) is the selectable
 * pool from responseFormat — correct + distractors, unmarked.
 */
export interface L3Field {
  key: string;
  label: string;
  kind: 'multi' | 'multiText' | 'single' | 'text' | 'prompt';
  options?: string[];
  maxLen?: number;
}

/** The answer-free L3 실습형 render spec derived from TaskTemplate.rubric. */
export interface L3ClientView {
  practiceType: string | null;
  fixedAiOutput: string | null;
  fields: L3Field[];
  reason: { min: number; max: number };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const L3_KEY_LABELS: Record<string, string> = {
  ai_usable_tasks: 'AI 활용 가능 작업',
  human_review_points: '사람 검토 지점',
  must_exclude_input: '제외해야 할 입력자료',
  required_elements: '필수 포함 요소',
  required_issues: '문제점 (복수 선택)',
  first_action: '최초 조치',
  highest_risk: '가장 큰 리스크',
  immediate_action: '즉시 조치',
  example_prompt: '프롬프트 작성',
};
function l3Humanize(key: string): string {
  return L3_KEY_LABELS[key] ?? key.replace(/_/g, ' ');
}

/** Normalize a field key by stripping select_/check_/required_/must_ prefixes. */
function l3StripKey(key: string): string {
  let s = key.toLowerCase();
  while (/^(select|check|required|must)_/.test(s)) s = s.replace(/^(select|check|required|must)_/, '');
  return s.replace(/[_\s-]/g, '');
}

/** The responseFormat option pool (array) that corresponds to an answerKey field. */
function l3FindPool(responseFormat: Record<string, unknown>, key: string): string[] | null {
  const nk = l3StripKey(key);
  for (const [rk, rv] of Object.entries(responseFormat)) {
    if (Array.isArray(rv) && l3StripKey(rk) === nk) return rv.map((x) => String(x));
  }
  return null;
}

/** "80~150자" → {min:80,max:150}; "250자 이내" → {min:0,max:250}. */
function l3ParseLen(v: unknown, def: { min: number; max: number }): { min: number; max: number } {
  const s = typeof v === 'string' ? v : '';
  const range = s.match(/(\d+)\s*[~\-–]\s*(\d+)/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const upper = s.match(/(\d+)/);
  if (upper) return { min: 0, max: Number(upper[1]) };
  return def;
}

/**
 * Project the L3 실습형 rubric wrapper down to an answer-free render spec: one
 * field per answerKey slot (keyed by the answerKey field NAME so the client's
 * `selects` line up with the grader), option pools pulled from responseFormat.
 * The rubric's `answerKey` VALUES (correct answers), `key_reason`, and criterion
 * points are the grading ground truth and are deliberately never serialized.
 * Returns null for legacy L1/L2 rubrics or a task with no L3 wrapper.
 */
export function l3ClientView(rubric: unknown): L3ClientView | null {
  const r = asRecord(rubric);
  if (!r) return null;
  const answerKey = asRecord(r.answerKey);
  const responseFormat = asRecord(r.responseFormat) ?? {};
  if (!answerKey && !asRecord(r.responseFormat) && !('practiceType' in r)) return null;

  const fields: L3Field[] = [];
  for (const [k, v] of Object.entries(answerKey ?? {})) {
    if (k === 'key_reason') continue; // graded via the 근거(shortReason) field
    if (k === 'example_prompt') {
      fields.push({ key: k, label: l3Humanize(k), kind: 'prompt', maxLen: l3ParseLen(responseFormat.write_prompt, { min: 0, max: 250 }).max });
      continue;
    }
    const pool = l3FindPool(responseFormat, k);
    const isArray = Array.isArray(v);
    fields.push({
      key: k,
      label: l3Humanize(k),
      kind: isArray ? (pool ? 'multi' : 'multiText') : pool ? 'single' : 'text',
      ...(pool ? { options: pool } : {}),
    });
  }
  // Fallback: no answerKey (shouldn't happen for L3) — render responseFormat arrays.
  if (fields.length === 0) {
    for (const [k, v] of Object.entries(responseFormat)) {
      if (Array.isArray(v)) fields.push({ key: k, label: l3Humanize(k), kind: 'multi', options: v.map((x) => String(x)) });
    }
  }

  return {
    practiceType: typeof r.practiceType === 'string' ? r.practiceType : null,
    fixedAiOutput: typeof r.fixedAiOutput === 'string' ? r.fixedAiOutput : null,
    fields,
    reason: l3ParseLen(responseFormat.short_reason, { min: 80, max: 150 }),
  };
}

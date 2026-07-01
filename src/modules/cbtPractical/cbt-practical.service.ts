import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ExamPart, ExamSessionStatus, Prisma, ProctorEventType } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { ClaudeExamAssistantService } from '../../integrations/anthropic/claude-exam-assistant.service';
import { NcObjectStorageService } from '../../integrations/ncObjectStorage/nc-object-storage.service';
import { ConfigService } from '@nestjs/config';
import { ExamSessionPauseService } from '../adminMonitor/exam-session-pause.service';
import { assertRegistrationActiveForSession } from '../cbtSessions/registration-active-guard';
import { evaluatePromptScope, SiblingTaskSnapshot } from './prompt-scope-guard';

/**
 * Tokens in a task's `aiToolAllowed` that mean "no AI for this question". The
 * authored content marks each task's AI policy per the spec's
 * `allowed_ai_environment` — practical/실습형 tasks carry an internal-AI tool
 * (e.g. "LMS 내장 AI"), while 서술형 essays carry "AI 사용 불가". The in-exam
 * assistant is permitted only when the task allows it.
 */
const AI_DISALLOWED_RE = /불가|불허|없음|금지|미허용|none|not\s*allowed|n\/?a/i;

/**
 * Whether the in-exam AI assistant is allowed for a task, driven by the
 * authored `aiToolAllowed` field (the documentation's per-task AI policy).
 * Empty/unset → disallowed (conservative): a task must explicitly grant the
 * built-in AI tool. External AI is never offered by this system at all.
 */
export function isExamAiAllowed(aiToolAllowed: string | null | undefined): boolean {
  const v = (aiToolAllowed ?? '').trim();
  if (!v) return false;
  return !AI_DISALLOWED_RE.test(v);
}

@Injectable()
export class CbtPracticalService {
  private readonly logger = new Logger(CbtPracticalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly assistant: ClaudeExamAssistantService,
    private readonly ncp: NcObjectStorageService,
    private readonly config: ConfigService,
    private readonly pause: ExamSessionPauseService,
  ) {}

  /**
   * In-exam AI assistant turn. The practical exam ("AI 활용") expects candidates
   * to use an embedded assistant; this answers their prompt grounded in the
   * task scenario. The conversation is persisted client-side via save() and
   * logged in EssayAnswer.aiChatLog for grader review.
   */
  async askAi(
    userId: string,
    sessionId: string,
    body: { taskId: string; prompt: string; history?: { role: 'user' | 'assistant'; text: string }[] },
  ) {
    await this.pause.assertNotPaused(sessionId);
    const session = await this.prisma.examSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException();
    if (session.userId !== userId) throw new ForbiddenException();
    if (session.status !== ExamSessionStatus.IN_PROGRESS) throw new BadRequestException('Exam not in progress');
    if (session.hardDeadline && new Date() > session.hardDeadline) throw new BadRequestException('Time over');
    await assertRegistrationActiveForSession(this.prisma, session.registrationId);

    const prompt = (body.prompt ?? '').trim();
    if (!prompt) throw new BadRequestException('Prompt is required');

    const task = await this.prisma.taskTemplate.findUnique({ where: { id: body.taskId } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.certType !== session.certType || task.level !== session.level) {
      throw new BadRequestException('Task does not belong to this exam');
    }
    // Only the tasks actually assigned to this session are answerable.
    const assigned = await this.prisma.essayAnswer.findUnique({
      where: { sessionId_taskId: { sessionId, taskId: body.taskId } },
    });
    if (!assigned) throw new BadRequestException('Task not part of this exam session');

    // The in-exam assistant is allowed ONLY where the authored task permits it
    // (practical/실습형 + any task whose `aiToolAllowed` grants the built-in AI).
    // 서술형 essays are marked "AI 사용 불가" → reject. This is the authoritative
    // server-side gate; the UI hides the chat too, but never trust the client.
    if (!isExamAiAllowed(task.aiToolAllowed)) {
      throw new ForbiddenException('이 문항에서는 AI 어시스턴트를 사용할 수 없습니다.');
    }

    // Scope guard — prevent the candidate from pasting another (AI-forbidden)
    // task's stem into this practical chat to trick the assistant into
    // drafting their essay. Trigram-cosine, deterministic, ~1ms; see
    // prompt-scope-guard.ts for thresholds. Any rejection is also written to
    // ProctoringEvent (AI_FLAG_SUSPICIOUS) for the admin live dashboard and
    // post-hoc grader review under Article 28.
    const siblings = await this.loadSiblingScopes(sessionId, body.taskId);
    const currentScope = this.buildScopeText({
      title: task.title,
      scenario: task.scenario,
      requiredStructure: task.requiredStructure,
    });
    const verdict = evaluatePromptScope(prompt, currentScope, siblings);
    if (verdict.kind !== 'ok') {
      // Persist the event regardless of outcome so the grader has audit trail.
      // We never store the full prompt — only the verdict + a length hint —
      // because the prompt may itself contain forbidden material we don't
      // want to duplicate into the proctoring table.
      await this.recordScopeEvent(sessionId, task.id, prompt.length, verdict).catch((e) =>
        this.logger.warn(`Failed to log scope event: ${(e as Error).message}`),
      );
      if (verdict.kind === 'reject') {
        const msg =
          verdict.reason === 'cross_task_paste_from_ai_forbidden'
            ? '다른 문항의 내용으로 보입니다. 현재 과제와 관련된 질문만 가능합니다.'
            : '현재 과제와 무관한 내용입니다. 시나리오와 관련된 질문만 입력하세요.';
        throw new ForbiddenException(msg);
      }
      // 'flag' falls through — the call proceeds, the event is logged for review.
    }

    const result = await this.assistant.respond(
      {
        title: task.title,
        scenario: task.scenario,
        requiredStructure: task.requiredStructure,
        forbiddenRules: task.forbiddenRules,
        aiToolAllowed: task.aiToolAllowed,
      },
      (body.history ?? []).map((t) => ({ role: t.role, text: t.text })),
      prompt,
    );
    return { text: result.text, degraded: result.degraded };
  }

  async save(
    userId: string,
    sessionId: string,
    body: {
      taskId: string;
      contentText: string;
      aiChatLog?: { role: 'user' | 'assistant'; text: string; ts: number }[];
      version: number;
    },
  ) {
    await this.pause.assertNotPaused(sessionId);
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.examSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new NotFoundException();
      if (session.userId !== userId) throw new ForbiddenException();
      if (session.status !== ExamSessionStatus.IN_PROGRESS) throw new BadRequestException('Exam not in progress');
      if (session.hardDeadline && new Date() > session.hardDeadline) throw new BadRequestException('Time over');
      await assertRegistrationActiveForSession(this.prisma, session.registrationId);

      const task = await tx.taskTemplate.findUnique({ where: { id: body.taskId } });
      if (!task) throw new NotFoundException('Task not found');
      if (task.certType !== session.certType || task.level !== session.level) {
        throw new BadRequestException('Task does not belong to this exam');
      }

      const existing = await tx.essayAnswer.findUnique({
        where: { sessionId_taskId: { sessionId, taskId: body.taskId } },
      });
      if (existing) {
        if (existing.version !== body.version) {
          throw new ConflictException({ message: 'Version mismatch', currentVersion: existing.version });
        }
        const updated = await tx.essayAnswer.update({
          where: { id: existing.id },
          data: {
            contentText: body.contentText,
            aiChatLog: (body.aiChatLog ?? null) as Prisma.InputJsonValue,
            version: { increment: 1 },
          },
        });
        return { taskId: body.taskId, version: updated.version };
      }
      if (body.version !== 0) throw new ConflictException({ message: 'Initial save must use version 0', currentVersion: 0 });
      const created = await tx.essayAnswer.create({
        data: {
          sessionId,
          taskId: body.taskId,
          part: task.part,
          contentText: body.contentText,
          aiChatLog: (body.aiChatLog ?? null) as Prisma.InputJsonValue,
          version: 1,
        },
      });
      return { taskId: body.taskId, version: created.version };
    });
  }

  /**
   * Upload a deliverable file for an L1 DELIVERABLE-part task. Validates the
   * session is active and the task part is DELIVERABLE, then puts the file into
   * the `axis-deliverables` NCP bucket and writes the resulting key as
   * `EssayAnswer.attachmentUrl`. The URL stored is the bucket key, not a
   * pre-signed URL — graders fetch a short-lived signed URL at review time.
   */
  async uploadDeliverable(
    userId: string,
    sessionId: string,
    taskId: string,
    file: Express.Multer.File,
  ): Promise<{ attachmentUrl: string }> {
    await this.pause.assertNotPaused(sessionId);
    const session = await this.prisma.examSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException();
    if (session.userId !== userId) throw new ForbiddenException();
    if (session.status !== ExamSessionStatus.IN_PROGRESS) throw new BadRequestException('Exam not in progress');
    if (session.hardDeadline && new Date() > session.hardDeadline) throw new BadRequestException('Time over');
    await assertRegistrationActiveForSession(this.prisma, session.registrationId);

    const task = await this.prisma.taskTemplate.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.part !== ExamPart.DELIVERABLE) {
      throw new BadRequestException('File upload is only allowed for DELIVERABLE-part tasks.');
    }
    if (task.certType !== session.certType || task.level !== session.level) {
      throw new BadRequestException('Task does not belong to this exam');
    }

    const assigned = await this.prisma.essayAnswer.findUnique({
      where: { sessionId_taskId: { sessionId, taskId } },
    });
    if (!assigned) throw new BadRequestException('Task not part of this exam session');

    const ext = file.originalname.includes('.')
      ? file.originalname.split('.').pop()!.toLowerCase()
      : 'bin';
    const key = `deliverables/${sessionId}/${taskId}/${Date.now()}.${ext}`;
    const bucket = this.config.get<{ bucketDeliverables: string }>('ncp')?.bucketDeliverables ?? 'axis-deliverables';

    await this.ncp.put(bucket, key, file.buffer, file.mimetype, 365 * 3);

    await this.prisma.essayAnswer.update({
      where: { id: assigned.id },
      data: { attachmentUrl: key },
    });

    return { attachmentUrl: key };
  }

  /**
   * Load the stems of every OTHER task assigned to this session, tagged with
   * each sibling's AI policy. Used by the scope guard to detect when the
   * current prompt looks like a paste from another task — especially one
   * whose authored policy forbids AI ("AI 사용 불가").
   */
  private async loadSiblingScopes(sessionId: string, currentTaskId: string): Promise<SiblingTaskSnapshot[]> {
    const rows = await this.prisma.essayAnswer.findMany({
      where: { sessionId, NOT: { taskId: currentTaskId } },
      select: { taskId: true },
    });
    if (rows.length === 0) return [];

    const tasks = await this.prisma.taskTemplate.findMany({
      where: { id: { in: rows.map((r) => r.taskId) } },
      select: {
        id: true,
        title: true,
        scenario: true,
        requiredStructure: true,
        aiToolAllowed: true,
      },
    });
    const taskById = new Map(tasks.map((t) => [t.id, t]));

    return rows
      .map((r) => taskById.get(r.taskId))
      .filter((t): t is (typeof tasks)[number] => t != null)
      .map((t) => ({
        taskId: t.id,
        aiAllowed: isExamAiAllowed(t.aiToolAllowed),
        scopeText: this.buildScopeText({
          title: t.title,
          scenario: t.scenario,
          requiredStructure: t.requiredStructure,
        }),
      }));
  }

  private buildScopeText(t: { title: string; scenario: string; requiredStructure: string | null }): string {
    return [t.title, t.scenario, t.requiredStructure ?? ''].filter(Boolean).join('\n');
  }

  /**
   * Record a proctoring event for a scope-guard verdict. Reuses
   * AI_FLAG_SUSPICIOUS (no enum change needed); the actual reason lives in
   * metadata so the admin UI + grader review can drill in. We deliberately
   * DO NOT store the prompt body — only the length and verdict — so we
   * never duplicate potentially forbidden content into proctoring storage.
   */
  private async recordScopeEvent(
    sessionId: string,
    currentTaskId: string,
    promptLen: number,
    verdict: ReturnType<typeof evaluatePromptScope>,
  ): Promise<void> {
    if (verdict.kind === 'ok') return;
    const meta: Record<string, unknown> = {
      source: 'ai_scope_guard',
      currentTaskId,
      promptLen,
      kind: verdict.kind,
      reason: verdict.reason,
    };
    if (verdict.kind === 'reject' && verdict.reason === 'cross_task_paste_from_ai_forbidden') {
      meta.matchedTaskId = verdict.matchedTaskId;
      meta.sim = verdict.sim;
    } else if (verdict.kind === 'reject' && verdict.reason === 'off_topic_paste') {
      meta.onTopic = verdict.onTopic;
    } else if (verdict.kind === 'flag') {
      meta.matchedTaskId = verdict.matchedTaskId;
      meta.sim = verdict.sim;
    }
    await this.prisma.proctoringEvent.create({
      data: {
        sessionId,
        eventType: ProctorEventType.AI_FLAG_SUSPICIOUS,
        severity: verdict.kind === 'reject' ? 'high' : 'medium',
        captionKo:
          verdict.kind === 'reject'
            ? '다른 문항의 내용을 AI에 입력하려는 시도가 감지되었습니다.'
            : '다른 문항과 유사한 내용이 AI에 입력되었습니다 (검토 필요).',
        metadata: meta as Prisma.InputJsonValue,
      },
    });
  }
}

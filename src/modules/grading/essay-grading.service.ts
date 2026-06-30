import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TaskTemplate } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import {
  ClaudeEssayGraderService,
  EssayGradeResult,
  EssayGradeTask,
} from '../../integrations/anthropic/claude-essay-grader.service';
import { parseRubric } from './rubric';
import { GRADING_CONFIG } from './grading-config';

export interface AiPrescoreTaskOutcome {
  taskId: string;
  title: string;
  scored: boolean; // false when the model degraded (kept manual)
  pct?: number;
  band?: string;
  confidence?: number;
  riskFlags?: number;
}

export interface AiPrescoreSummary {
  sessionId: string;
  configured: boolean; // false when ANTHROPIC_API_KEY missing
  tasks: AiPrescoreTaskOutcome[];
}

/**
 * AI first-pass scoring orchestrator. Loads each practical/essay answer for a
 * session, grades it with ClaudeEssayGraderService against the task's rubric +
 * anchor exemplars, and writes the structured verdict back onto EssayAnswer.
 *
 * Idempotent and re-runnable: a degraded model call leaves the answer untouched
 * (manual grading still works), never overwriting prior AI/expert data with
 * zeros.
 */
@Injectable()
export class EssayGradingService {
  private readonly logger = new Logger(EssayGradingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly grader: ClaudeEssayGraderService,
  ) {}

  /** Build the grader's task input from a TaskTemplate (rubric → weighted criteria). */
  static toGradeTask(tpl: TaskTemplate): EssayGradeTask {
    return {
      title: tpl.title,
      scenario: tpl.scenario,
      criteria: parseRubric(tpl.rubric, tpl.points),
      points: tpl.points,
      modelAnswer: tpl.modelAnswer,
      benchmarkExcellent: tpl.benchmarkExcellent,
      benchmarkNormal: tpl.benchmarkNormal,
      benchmarkBorderline: tpl.benchmarkBorderline,
      benchmarkFail: tpl.benchmarkFail,
      riskCriteria: tpl.riskCriteria,
      forbiddenRules: tpl.forbiddenRules,
    };
  }

  async aiPrescoreSession(sessionId: string): Promise<AiPrescoreSummary> {
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      include: { essayAnswers: true },
    });
    if (!session) throw new NotFoundException('Session not found');

    const configured = this.grader.isConfigured();
    const outcomes: AiPrescoreTaskOutcome[] = [];

    const taskIds = Array.from(new Set(session.essayAnswers.map((e) => e.taskId)));
    const tasks = taskIds.length
      ? await this.prisma.taskTemplate.findMany({ where: { id: { in: taskIds } } })
      : [];
    const taskById = new Map(tasks.map((t) => [t.id, t]));

    for (const ans of session.essayAnswers) {
      const tpl = taskById.get(ans.taskId);
      if (!tpl) {
        outcomes.push({ taskId: ans.taskId, title: '(unknown task)', scored: false });
        continue;
      }
      const result = await this.grader.grade(EssayGradingService.toGradeTask(tpl), {
        contentText: ans.contentText,
        aiChatLog: ans.aiChatLog,
      });

      if (result.degraded) {
        outcomes.push({ taskId: tpl.id, title: tpl.title, scored: false });
        continue;
      }

      await this.persist(ans.id, result);
      outcomes.push({
        taskId: tpl.id,
        title: tpl.title,
        scored: true,
        pct: result.pct,
        band: result.band,
        confidence: result.confidence,
        riskFlags: result.riskFlags.length,
      });
    }

    // Spec expert-review triggers (§12-3): if any task came back low-confidence,
    // with a risk flag, or in the pass-boundary band, mark the whole session for
    // mandatory human scrutiny so graders prioritize it. Fail/borderline bands
    // also count (the candidate is near the cut).
    const mandatoryReview = outcomes.some(
      (o) =>
        o.scored &&
        ((o.confidence != null && o.confidence < GRADING_CONFIG.CONFIDENCE_FLOOR) ||
          (o.riskFlags ?? 0) > 0 ||
          o.band === 'borderline' ||
          o.band === 'fail'),
    );
    await this.prisma.examSession.update({
      where: { id: sessionId },
      data: { mandatoryReview },
    });

    this.logger.log(
      JSON.stringify({
        msg: 'session_ai_prescored',
        sessionId,
        configured,
        scored: outcomes.filter((o) => o.scored).length,
        total: outcomes.length,
      }),
    );

    return { sessionId, configured, tasks: outcomes };
  }

  private async persist(essayAnswerId: string, result: EssayGradeResult): Promise<void> {
    await this.prisma.essayAnswer.update({
      where: { id: essayAnswerId },
      data: {
        aiPreScore: result.pct,
        aiRationale: result.rationale,
        aiCriterionScores: result.criterionScores as unknown as object,
        aiRiskFlags: result.riskFlags as unknown as object,
        aiBand: result.band,
        aiConfidence: result.confidence,
        aiModel: result.model,
        aiPromptHash: result.promptHash,
        aiLatencyMs: result.latencyMs,
        aiScoredAt: new Date(),
      },
    });
  }
}

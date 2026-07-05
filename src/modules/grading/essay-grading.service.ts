import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EssayAnswer, Prisma, TaskTemplate } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import {
  ClaudeEssayGraderService,
  EssayGradeResult,
  EssayGradeRiskFlag,
  EssayGradeTask,
} from '../../integrations/anthropic/claude-essay-grader.service';
import { getScoring, getSectionFloorPct } from '../cbtSessions/exam-spec';
import { parseRubric, parseL3Reference, RubricCriterion } from './rubric';
import { GRADING_CONFIG } from './grading-config';
import { CodeGradingService } from './code-grading.service';
import { scanForbiddenPatterns } from './forbidden-patterns';
import { L3PracticalGraderService, parseL3Submission } from './l3-practical-grader.service';
import type { L3GradeResult, L3Submission } from './l3-practical-grader.types';
import { computeMandatoryReview, sessionReviewFromTaskPcts } from './review-triggers';
import {
  EssayGradePersist,
  GradingStrategyName,
  buildCodeExecutionSummary,
  claudeToPersist,
  l3ToPersist,
  mergeRationale,
  objectiveContext,
  planGrading,
} from './grading-strategy';

export interface AiPrescoreTaskOutcome {
  taskId: string;
  title: string;
  scored: boolean; // false when the model degraded (kept manual)
  pct?: number;
  band?: string;
  confidence?: number;
  riskFlags?: number;
}

/** Internal outcome carrying review-trigger context; stripped from the public summary. */
interface GradedOutcome extends AiPrescoreTaskOutcome {
  forceReview?: boolean;
  /** Section floor (%) for the task's part — feeds the numeric review triggers. */
  floorPct?: number | null;
}

export interface AiPrescoreSummary {
  sessionId: string;
  configured: boolean; // false when ANTHROPIC_API_KEY missing
  tasks: AiPrescoreTaskOutcome[];
}

type SessionWithAnswers = Prisma.ExamSessionGetPayload<{ include: { essayAnswers: true } }>;

/**
 * AI first-pass scoring dispatcher. For each EssayAnswer it picks a grading
 * strategy from the session level + task part (planGrading):
 *   - L3 PRACTICAL → deterministic answer-key grader, with an optional Claude
 *     rationale-only second pass when the rationale is borderline (hybrid).
 *   - L2 PRACTICAL / L1 DELIVERABLE·ESSAY → Claude rubric grader.
 *   - AXIS-C code → deterministic Judge0 when runnable, else Claude with an
 *     execution summary in context.
 *
 * Idempotent and re-runnable: a degraded Claude call leaves the answer untouched,
 * and earnedPoints is only pre-filled while no expert score exists yet.
 */
@Injectable()
export class EssayGradingService {
  private readonly logger = new Logger(EssayGradingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly grader: ClaudeEssayGraderService,
    private readonly codeGrading: CodeGradingService,
    private readonly l3Grader: L3PracticalGraderService,
  ) {}

  /** Build the Claude grader's task input from a TaskTemplate (rubric → weighted criteria). */
  static toGradeTask(tpl: TaskTemplate): EssayGradeTask {
    // L3 실습형 rubrics wrap the weighted criteria alongside a practice type,
    // response format, and answer key; parseL3Reference returns null for L1/L2.
    const l3 = parseL3Reference(tpl.rubric);
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
      // Fall back to the L3 task-level risk flags when no explicit riskCriteria
      // column is authored (the L3 seed populates riskFlags, not riskCriteria).
      riskCriteria: tpl.riskCriteria ?? l3?.riskFlags ?? null,
      forbiddenRules: tpl.forbiddenRules,
      requiredStructure: tpl.requiredStructure,
      practiceType: l3?.practiceType ?? null,
      responseFormat: l3?.responseFormat ?? null,
      answerKey: l3?.answerKey ?? null,
    };
  }

  async aiPrescoreSession(sessionId: string): Promise<AiPrescoreSummary> {
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      include: { essayAnswers: true },
    });
    if (!session) throw new NotFoundException('Session not found');

    const configured = this.grader.isConfigured();
    const taskIds = Array.from(new Set(session.essayAnswers.map((e) => e.taskId)));
    const tasks = taskIds.length
      ? await this.prisma.taskTemplate.findMany({ where: { id: { in: taskIds } } })
      : [];
    const taskById = new Map(tasks.map((t) => [t.id, t]));

    const outcomes: GradedOutcome[] = [];
    for (const ans of session.essayAnswers) {
      const tpl = taskById.get(ans.taskId);
      if (!tpl) {
        outcomes.push({ taskId: ans.taskId, title: '(unknown task)', scored: false });
        continue;
      }
      outcomes.push(await this.gradeAnswer(session, tpl, ans));
    }

    const mandatoryReview =
      computeMandatoryReview(outcomes) || this.sessionLevelReview(session, tasks, outcomes);
    await this.prisma.examSession.update({ where: { id: sessionId }, data: { mandatoryReview } });

    this.logger.log(
      JSON.stringify({
        msg: 'session_ai_prescored',
        sessionId,
        configured,
        scored: outcomes.filter((o) => o.scored).length,
        total: outcomes.length,
      }),
    );

    return {
      sessionId,
      configured,
      tasks: outcomes.map(({ forceReview: _f, floorPct: _fl, ...o }) => o),
    };
  }

  /**
   * Session-level numeric triggers (total within the pass boundary band, or a
   * practical section near/below its floor). Only evaluable once every task
   * carries an AI pct; per-task triggers still apply on partial prescores.
   */
  private sessionLevelReview(
    session: SessionWithAnswers,
    tasks: TaskTemplate[],
    outcomes: GradedOutcome[],
  ): boolean {
    if (outcomes.length === 0 || outcomes.some((o) => !o.scored || o.pct == null)) return false;
    const pctByTask = new Map(outcomes.map((o) => [o.taskId, o.pct ?? 0]));
    return sessionReviewFromTaskPcts(
      getScoring(session.certType, session.level),
      session.writtenScore ?? 0,
      tasks,
      pctByTask,
    );
  }

  /** Route one answer to the right grader per session level + task part. */
  private async gradeAnswer(
    session: SessionWithAnswers,
    tpl: TaskTemplate,
    ans: EssayAnswer,
  ): Promise<GradedOutcome> {
    const isCode = this.codeGrading.isCodeTask(tpl);
    const plan = planGrading({ level: session.level, part: tpl.part, isCodeTask: isCode });

    if (plan.strategy === 'l3_answer_key') {
      const submission = parseL3Submission(ans.contentText);
      if (submission) return this.gradeL3(session, tpl, ans, submission);
      // Legacy free-text L3 answer (pre-structured-UI): the answer-key grader
      // cannot apply, so grade with Claude AND always route to expert review.
      const outcome = await this.gradeWithClaude(
        session,
        tpl,
        ans,
        plan.includeChatLog,
        plan.includeExecutionSummary,
      );
      return ans.contentText.trim() ? { ...outcome, forceReview: true } : outcome;
    }

    if (isCode) {
      const codeResult = await this.codeGrading.autoGrade(tpl, ans.contentText);
      if (codeResult) {
        await this.persistResult(ans, claudeToPersist(codeResult));
        this.logGraded('code_autograde', tpl.id, session.id);
        return this.outcomeFromResult(session, tpl, codeResult, false);
      }
      // Judge0 could not execute this code task — NEVER silent-pass. Fall back
      // to Claude with the static forbidden-pattern flags attached and force
      // expert review so an unexecuted code submission is always human-checked.
      if (!this.codeGrading.isJudge0Configured()) {
        this.logger.warn(
          JSON.stringify({
            msg: 'judge0_unconfigured_code_task_forced_review',
            sessionId: session.id,
            taskId: tpl.id,
          }),
        );
      }
      const outcome = await this.gradeWithClaude(
        session,
        tpl,
        ans,
        plan.includeChatLog,
        plan.includeExecutionSummary,
        scanForbiddenPatterns(ans.contentText),
      );
      return { ...outcome, forceReview: true };
    }

    return this.gradeWithClaude(session, tpl, ans, plan.includeChatLog, plan.includeExecutionSummary);
  }

  private async gradeL3(
    session: SessionWithAnswers,
    tpl: TaskTemplate,
    ans: EssayAnswer,
    submission: L3Submission,
  ): Promise<GradedOutcome> {
    const criteria = parseRubric(tpl.rubric, tpl.points);
    const maxTotal = criteria.reduce((s, c) => s + c.maxPoints, 0) || tpl.points;
    const base = this.l3Grader.gradeL3Practical({ points: tpl.points, rubric: tpl.rubric }, submission);

    let final = base;
    let aiModel = 'l3-answer-key';
    let confidence = 0.9; // deterministic answer-key match
    let rationaleLowConf = false;

    if (base.needsClaudeRationaleAssist && this.grader.isConfigured()) {
      const assist = await this.assistRationale(tpl, ans, base, criteria);
      if (assist && !assist.degraded) {
        final = mergeRationale(base, assist, maxTotal);
        aiModel = 'hybrid-l3+claude';
        confidence = assist.confidence;
        rationaleLowConf = assist.confidence < GRADING_CONFIG.CONFIDENCE_FLOOR;
      }
    }

    await this.persistResult(ans, l3ToPersist(final, aiModel, confidence));
    this.logGraded('l3_answer_key', tpl.id, session.id);
    return {
      taskId: tpl.id,
      title: tpl.title,
      scored: true,
      pct: final.pct,
      riskFlags: final.riskFlags.length,
      forceReview: final.needsExpertReview || rationaleLowConf,
      floorPct: getSectionFloorPct(session.certType, session.level, tpl.part),
    };
  }

  /** Focused Claude call: grade ONLY the rationale criterion, given objective scores. */
  private async assistRationale(
    tpl: TaskTemplate,
    ans: EssayAnswer,
    l3: L3GradeResult,
    criteria: RubricCriterion[],
  ): Promise<EssayGradeResult | null> {
    const rationaleCriterion = criteria.find((c) => /근거|서술|rationale|reason|이유/i.test(c.label));
    if (!rationaleCriterion) return null;
    const base = EssayGradingService.toGradeTask(tpl);
    const focused: EssayGradeTask = {
      ...base,
      criteria: [rationaleCriterion],
      scenario:
        `${base.scenario}\n\n[안내] 객관식/체크리스트 항목은 이미 자동 채점되었습니다. ` +
        `아래 루브릭의 근거(서술) 기준만 채점하세요.\n${objectiveContext(l3)}`,
    };
    return this.grader.grade(
      focused,
      { contentText: ans.contentText, aiChatLog: ans.aiChatLog },
      tpl.part,
      tpl.certType,
    );
  }

  private async gradeWithClaude(
    session: SessionWithAnswers,
    tpl: TaskTemplate,
    ans: EssayAnswer,
    includeChatLog: boolean,
    includeExecutionSummary: boolean,
    extraRiskFlags: EssayGradeRiskFlag[] = [],
  ): Promise<GradedOutcome> {
    const executionSummary = includeExecutionSummary
      ? buildCodeExecutionSummary(session, tpl.id, ans.contentText)
      : null;
    const raw = await this.grader.grade(
      EssayGradingService.toGradeTask(tpl),
      {
        contentText: ans.contentText,
        aiChatLog: includeChatLog ? ans.aiChatLog : undefined,
        executionSummary,
      },
      tpl.part,
      tpl.certType,
    );
    if (raw.degraded) return { taskId: tpl.id, title: tpl.title, scored: false };

    const result: EssayGradeResult = extraRiskFlags.length
      ? { ...raw, riskFlags: [...extraRiskFlags, ...raw.riskFlags] }
      : raw;
    await this.persistResult(ans, claudeToPersist(result));
    this.logGraded('claude_rubric', tpl.id, session.id);
    return this.outcomeFromResult(session, tpl, result, false);
  }

  private outcomeFromResult(
    session: SessionWithAnswers,
    tpl: TaskTemplate,
    result: EssayGradeResult,
    forceReview: boolean,
  ): GradedOutcome {
    return {
      taskId: tpl.id,
      title: tpl.title,
      scored: true,
      pct: result.pct,
      band: result.band,
      confidence: result.confidence,
      riskFlags: result.riskFlags.length,
      forceReview,
      floorPct: getSectionFloorPct(session.certType, session.level, tpl.part),
    };
  }

  private logGraded(strategy: GradingStrategyName, taskId: string, sessionId: string): void {
    this.logger.log(JSON.stringify({ msg: 'task_graded', strategy, taskId, sessionId }));
  }

  private async persistResult(ans: EssayAnswer, p: EssayGradePersist): Promise<void> {
    await this.prisma.essayAnswer.update({
      where: { id: ans.id },
      data: {
        aiPreScore: p.pct,
        // Pre-fill raw points, but never clobber an expert-finalized value on re-run.
        ...(ans.expertScore == null ? { earnedPoints: p.earnedPoints } : {}),
        aiRationale: p.rationale,
        aiCriterionScores: p.criterionScores as object,
        aiRiskFlags: p.riskFlags as object,
        aiBand: p.band,
        aiConfidence: p.confidence,
        aiModel: p.model,
        aiPromptHash: p.promptHash,
        aiLatencyMs: p.latencyMs,
        aiScoredAt: new Date(),
      },
    });
  }
}

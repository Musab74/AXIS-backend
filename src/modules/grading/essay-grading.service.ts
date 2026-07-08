import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CertLevel, DecisionStatus, EssayAnswer, ExamPart, Prisma, TaskTemplate } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import {
  ClaudeEssayGraderService,
  EssayGradeResult,
  EssayGradeRiskFlag,
  EssayGradeTask,
} from '../../integrations/anthropic/claude-essay-grader.service';
import { getScoring, getSectionFloorPct, toSpecVersion } from '../cbtSessions/exam-spec';
import { parseRubric, parseL3Reference, RubricCriterion } from './rubric';
import { AI_GRADING_PROMPT_VERSION, GRADING_CONFIG } from './grading-config';
import { CodeGradingService } from './code-grading.service';
import { scanForbiddenPatterns } from './forbidden-patterns';
import { L3PracticalGraderService, parseL3Submission } from './l3-practical-grader.service';
import type { L3GradeResult, L3Submission } from './l3-practical-grader.types';
import { BaselineGateService, BaselineGateStatus } from './baseline-gate.service';
import { sessionReviewV2, TaskScoreV2 } from './review-bands';
import { computeMandatoryReview, sessionReviewFromTaskPcts } from './review-triggers';
import { SessionAggregateService } from './session-aggregate.service';
import { gradeTerminatedWrittenSection } from './written-scoring';
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
    private readonly aggregates: SessionAggregateService,
    private readonly baselineGate: BaselineGateService,
  ) {}

  /** Rubric version for the audit trail: seed `rubric_version` else TaskTemplate.version. */
  static rubricVersionOf(tpl: TaskTemplate): string {
    const wrapper = tpl.rubric as { rubric_version?: unknown } | null;
    const fromRubric = wrapper && typeof wrapper === 'object' ? wrapper.rubric_version : null;
    return typeof fromRubric === 'string' && fromRubric.trim() ? fromRubric.trim() : `v${tpl.version}`;
  }

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
      rubricVersion: EssayGradingService.rubricVersionOf(tpl),
    };
  }

  async aiPrescoreSession(sessionId: string): Promise<AiPrescoreSummary> {
    // "Grade the exam" on a force-terminated session: make sure its MCQ
    // written section is scored first (no-op for non-terminated or
    // already-scored sessions) so one click grades everything gradeable.
    await gradeTerminatedWrittenSection(this.prisma, sessionId);

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

    // v2.0 decision state machine (WP4): prescore completion stages the
    // session as PROVISIONAL, or IN_REVIEW when any review trigger fired.
    // Never regress a decision a human already locked (confirmed/invalidated).
    const locked =
      session.decisionStatus === DecisionStatus.CONFIRMED_PASS ||
      session.decisionStatus === DecisionStatus.CONFIRMED_FAIL ||
      session.decisionStatus === DecisionStatus.INVALIDATED;
    const decisionStatus =
      toSpecVersion(session.specVersion) === '2.0' && !locked
        ? mandatoryReview
          ? DecisionStatus.IN_REVIEW
          : DecisionStatus.PROVISIONAL
        : undefined;
    await this.prisma.examSession.update({
      where: { id: sessionId },
      data: { mandatoryReview, ...(decisionStatus ? { decisionStatus } : {}) },
    });

    // WP7: prescore completion is an aggregation point (no-op for v1.1).
    this.aggregates.rebuildSafely(sessionId, 'ai_prescore');

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
   * Session-level numeric triggers. Only evaluable once every task carries an
   * AI pct; per-task triggers still apply on partial prescores.
   *   v1.1: generic ±band window around passTotal / section floors.
   *   v2.0: explicit per-level boundary bands + hard-cut misses + per-task
   *   flags (review-bands.ts) on the point scales of the aggregate schemas.
   */
  private sessionLevelReview(
    session: SessionWithAnswers,
    tasks: TaskTemplate[],
    outcomes: GradedOutcome[],
  ): boolean {
    if (outcomes.length === 0 || outcomes.some((o) => !o.scored || o.pct == null)) return false;
    const pctByTask = new Map(outcomes.map((o) => [o.taskId, o.pct ?? 0]));
    const specVersion = toSpecVersion(session.specVersion);
    const scoring = getScoring(session.certType, session.level, specVersion);
    if (specVersion !== '2.0') {
      return sessionReviewFromTaskPcts(scoring, session.writtenScore ?? 0, tasks, pctByTask);
    }

    // v2.0: rebuild the point-scale scores the aggregate schemas use. The
    // written section's weight is its point max (60/30/25); practical points
    // sum the raw task maxes with the AI pct applied.
    const writtenWeight = scoring.sections.find((s) => s.part === ExamPart.WRITTEN)?.weight ?? 0;
    const objective = ((session.writtenScore ?? 0) / 100) * writtenWeight;
    const taskScores: TaskScoreV2[] = tasks.map((t) => {
      const l3 = parseL3Reference(t.rubric);
      const practiceType = (l3?.practiceType ?? t.taskType ?? '').replace(/[\s·]/g, '');
      return {
        key: t.id,
        score: ((pctByTask.get(t.id) ?? 0) / 100) * t.points,
        max: t.points,
        isRiskJudgementType: practiceType.includes('리스크판단'),
      };
    });
    // L1: Part B(DELIVERABLE) is the "practice" gate section; Part C(ESSAY) has
    // no hard cut but keeps its <12 review trigger. L2/L3: PRACTICAL.
    const partOf = (part: ExamPart) =>
      tasks.filter((t) => t.part === part).reduce(
        (acc, t) => acc + ((pctByTask.get(t.id) ?? 0) / 100) * t.points,
        0,
      );
    const isL1 = session.level === 'L1';
    const practice = isL1 ? partOf(ExamPart.DELIVERABLE) : partOf(ExamPart.PRACTICAL);
    const partC = isL1 ? partOf(ExamPart.ESSAY) : undefined;
    const total = Math.round(
      objective + practice + (partC ?? 0),
    );
    const review = sessionReviewV2(session.level, {
      total,
      objective,
      practice,
      partC,
      taskScores,
    });
    return review.humanReviewRequired;
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

    // WP8 baseline gate: the L3 selection auto-score is deterministic (AI
    // 미개입) and stays; the AI-assisted share (Claude rationale assist) only
    // runs when the baseline passed, and shadow mode routes to the expert queue.
    const gate = await this.baselineGate.status(
      session.level,
      parseL3Reference(tpl.rubric)?.practiceType ?? tpl.taskType,
      AI_GRADING_PROMPT_VERSION.L3,
    );
    if (base.needsClaudeRationaleAssist && this.grader.isConfigured() && gate.live) {
      const assist = await this.assistRationale(tpl, ans, base, criteria);
      if (assist && !assist.degraded) {
        final = mergeRationale(base, assist, maxTotal);
        aiModel = 'hybrid-l3+claude';
        confidence = assist.confidence;
        rationaleLowConf = assist.confidence < GRADING_CONFIG.CONFIDENCE_FLOOR;
      }
    }

    await this.persistResult(
      ans,
      l3ToPersist(final, aiModel, confidence, {
        promptVersion: AI_GRADING_PROMPT_VERSION.L3,
        rubricVersion: EssayGradingService.rubricVersionOf(tpl),
      }),
      gate.live,
    );
    this.logGraded('l3_answer_key', tpl.id, session.id);
    return {
      taskId: tpl.id,
      title: tpl.title,
      scored: true,
      pct: final.pct,
      riskFlags: final.riskFlags.length,
      // Shadow mode (WP8): every AI-touched task goes to the expert queue.
      forceReview: final.needsExpertReview || rationaleLowConf || !gate.live,
      floorPct: getSectionFloorPct(
        session.certType,
        session.level,
        tpl.part,
        toSpecVersion(session.specVersion),
      ),
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
      CertLevel.L3,
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
    // WP8 baseline gate: criteria that failed the per-criterion baseline are
    // excluded from AI scoring (expert direct scoring); without a passed gate
    // the whole call runs in shadow mode.
    const levelKey = session.level as 'L1' | 'L2' | 'L3';
    const gate = await this.baselineGate.status(
      session.level,
      parseL3Reference(tpl.rubric)?.practiceType ?? tpl.taskType,
      AI_GRADING_PROMPT_VERSION[levelKey],
    );
    const task = EssayGradingService.toGradeTask(tpl);
    const gradedTask =
      gate.excludedCriteria.length > 0
        ? { ...task, criteria: task.criteria.filter((c) => !gate.excludedCriteria.some((x) => c.label.includes(x))) }
        : task;
    const raw = await this.grader.grade(
      gradedTask,
      {
        contentText: ans.contentText,
        aiChatLog: includeChatLog ? ans.aiChatLog : undefined,
        executionSummary,
      },
      tpl.part,
      tpl.certType,
      session.level,
    );
    if (raw.degraded) return { taskId: tpl.id, title: tpl.title, scored: false };

    const result: EssayGradeResult = extraRiskFlags.length
      ? { ...raw, riskFlags: [...extraRiskFlags, ...raw.riskFlags] }
      : raw;
    await this.persistResult(
      ans,
      claudeToPersist(result, EssayGradingService.rubricVersionOf(tpl)),
      gate.live,
    );
    this.logGraded('claude_rubric', tpl.id, session.id);
    // v2.0 contract triggers: a nominated gate, an injection suspicion, a
    // critical-fail candidate, shadow mode, or an AI-excluded criterion always
    // routes the session to expert review.
    const contractReview =
      result.gate.triggered ||
      result.injectionSuspected ||
      result.criticalFailCandidates.length > 0 ||
      !gate.live ||
      gate.excludedCriteria.length > 0;
    return this.outcomeFromResult(session, tpl, result, contractReview);
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
      floorPct: getSectionFloorPct(
        session.certType,
        session.level,
        tpl.part,
        toSpecVersion(session.specVersion),
      ),
    };
  }

  private logGraded(strategy: GradingStrategyName, taskId: string, sessionId: string): void {
    this.logger.log(JSON.stringify({ msg: 'task_graded', strategy, taskId, sessionId }));
  }

  private async persistResult(
    ans: EssayAnswer,
    p: EssayGradePersist,
    prefillEarned = true,
  ): Promise<void> {
    await this.prisma.essayAnswer.update({
      where: { id: ans.id },
      data: {
        aiPreScore: p.pct,
        // Pre-fill raw points, but never clobber an expert-finalized value on
        // re-run — and never prefill in baseline SHADOW mode (WP8: AI scores
        // are stored as reference only until the baseline passes).
        ...(ans.expertScore == null && prefillEarned ? { earnedPoints: p.earnedPoints } : {}),
        aiRationale: p.rationale,
        aiCriterionScores: p.criterionScores as object,
        aiRiskFlags: p.riskFlags as object,
        aiBand: p.band,
        aiConfidence: p.confidence,
        aiModel: p.model,
        aiPromptHash: p.promptHash,
        aiLatencyMs: p.latencyMs,
        aiScoredAt: new Date(),
        // v2.0 AI contract (WP6)
        aiGate: (p.gate ?? undefined) as object | undefined,
        aiCriticalFails: (p.criticalFails ?? undefined) as object | undefined,
        aiInjectionSuspected: p.injectionSuspected,
        aiPromptVersion: p.promptVersion,
        aiRubricVersion: p.rubricVersion,
      },
    });
  }
}

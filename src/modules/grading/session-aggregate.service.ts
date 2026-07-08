/**
 * v2.0 (WP7) session aggregation: builds ONE per-examinee aggregate record per
 * session, shaped by the level's AXIS_L*_채점_세션집계_JSON스키마_v1_0.json,
 * validates it against the bundled schema (ajv), and upserts it into
 * SessionAggregate. Rebuilt at prescore-complete and at every score change /
 * decision confirmation; always upserted even when validation fails
 * (schemaValid=false + errors recorded) so ops can see WHY a record is off.
 *
 * v1.1 sessions are skipped — the aggregate record is a v2.0 artifact.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CertLevel, DecisionStatus, ExamPart, Prisma, TaskTemplate } from '@prisma/client';
import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma.service';
import {
  computeWeightedResult,
  getScoring,
  getTiming,
  toSpecVersion,
} from '../cbtSessions/exam-spec';
import {
  AI_GRADING_PROMPT_VERSION,
  CRITICAL_FAIL_PATTERNS,
  GRADING_CONFIG,
  RISK_VOCAB_L1_L2,
  RISK_VOCAB_L3,
  severityForRiskTag,
} from './grading-config';
import { sessionReviewV2, TaskScoreV2 } from './review-bands';
import { parseL3Reference } from './rubric';
import { SESSION_AGGREGATE_SCHEMAS } from './session-aggregate-schemas';

type SessionWithAnswers = Prisma.ExamSessionGetPayload<{ include: { essayAnswers: true } }>;

/**
 * Canonical practice types in the task bank (seed normalization strips
 * dots/spaces) → the enum spellings of the L3 aggregate schema.
 */
const L3_PRACTICE_TYPE_LABELS: Record<string, string> = {
  현업적용형: '현업적용형',
  지시설계형: '지시설계형',
  분석검증형: '분석·검증형',
  리스크판단형: '리스크 판단형',
};

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 비식별 응시자 해시 — 원식별자(이름·연락처) 전송/저장 금지 (스키마 규정). */
function applicantRef(userId: string): string {
  return `appl-${sha256(userId).slice(0, 24)}`;
}

@Injectable()
export class SessionAggregateService {
  private readonly logger = new Logger(SessionAggregateService.name);
  private readonly validators: Record<'L1' | 'L2' | 'L3', ValidateFunction>;

  constructor(private readonly prisma: PrismaService) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    this.validators = {
      L1: ajv.compile(SESSION_AGGREGATE_SCHEMAS.L1 as unknown as object),
      L2: ajv.compile(SESSION_AGGREGATE_SCHEMAS.L2 as unknown as object),
      L3: ajv.compile(SESSION_AGGREGATE_SCHEMAS.L3 as unknown as object),
    };
  }

  /**
   * Rebuild (upsert) the aggregate for one session. Never throws on data
   * problems — a failed aggregation must not break grading; callers
   * fire-and-forget with `.catch(...)` or use the returned row.
   */
  async rebuild(sessionId: string) {
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      include: { essayAnswers: true },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (toSpecVersion(session.specVersion) !== '2.0') {
      this.logger.log(
        JSON.stringify({ msg: 'aggregate_skipped_v11', sessionId, specVersion: session.specVersion }),
      );
      return null;
    }

    const taskIds = Array.from(new Set(session.essayAnswers.map((e) => e.taskId)));
    const tasks = taskIds.length
      ? await this.prisma.taskTemplate.findMany({ where: { id: { in: taskIds } } })
      : [];
    const record = this.buildRecord(session, tasks);
    const levelKey = session.level as 'L1' | 'L2' | 'L3';
    const validate = this.validators[levelKey];
    const schemaValid = validate(record.json) as boolean;
    const schemaErrors = schemaValid
      ? null
      : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
    if (!schemaValid) {
      this.logger.warn(
        JSON.stringify({ msg: 'aggregate_schema_invalid', sessionId, errors: schemaErrors }),
      );
    }

    const row = await this.prisma.sessionAggregate.upsert({
      where: { sessionId },
      create: {
        sessionId,
        certType: session.certType,
        level: session.level,
        decisionStatus: record.decisionStatus,
        humanReviewRequired: record.humanReviewRequired,
        schemaValid,
        schemaErrors: schemaErrors as unknown as Prisma.InputJsonValue,
        record: record.json as unknown as Prisma.InputJsonValue,
        internalReviewReasons: record.internalReasons as unknown as Prisma.InputJsonValue,
        aggregatedAt: record.aggregatedAt,
      },
      update: {
        decisionStatus: record.decisionStatus,
        humanReviewRequired: record.humanReviewRequired,
        schemaValid,
        schemaErrors: schemaErrors as unknown as Prisma.InputJsonValue,
        record: record.json as unknown as Prisma.InputJsonValue,
        internalReviewReasons: record.internalReasons as unknown as Prisma.InputJsonValue,
        aggregatedAt: record.aggregatedAt,
      },
    });

    // L2 audit surfacing (WP5): persist the prompt-log ref + hash onto the
    // session row the first time they are computed.
    if (
      session.level === CertLevel.L2 &&
      record.promptLogHash &&
      (session.promptLogHash !== record.promptLogHash || !session.promptLogRef)
    ) {
      await this.prisma.examSession.update({
        where: { id: sessionId },
        data: { promptLogRef: record.promptLogRef, promptLogHash: record.promptLogHash },
      });
    }

    this.logger.log(
      JSON.stringify({
        msg: 'session_aggregated',
        sessionId,
        level: session.level,
        decisionStatus: record.decisionStatus,
        humanReviewRequired: record.humanReviewRequired,
        schemaValid,
      }),
    );
    return row;
  }

  /** Fire-and-forget wrapper for grading paths (aggregation must never block them). */
  rebuildSafely(sessionId: string, origin: string): void {
    void this.rebuild(sessionId).catch((err) =>
      this.logger.warn(
        `session aggregate rebuild failed (origin=${origin}, session=${sessionId}): ${(err as Error).message}`,
      ),
    );
  }

  /** Admin/export read — returns the stored aggregate row (404 when absent). */
  async get(sessionId: string) {
    const row = await this.prisma.sessionAggregate.findUnique({ where: { sessionId } });
    if (!row) {
      throw new NotFoundException(
        'No aggregate record for this session (v1.1 session, or grading has not completed).',
      );
    }
    return row;
  }

  // ── record assembly ───────────────────────────────────────────────────────

  private buildRecord(session: SessionWithAnswers, tasks: TaskTemplate[]) {
    const specVersion = toSpecVersion(session.specVersion);
    const level = session.level;
    const scoring = getScoring(session.certType, level, specVersion);
    const timing = getTiming(session.certType, level, specVersion);
    const taskById = new Map(tasks.map((t) => [t.id, t]));

    // Point-scale scores. The written section's weight equals its point max
    // (60/30/25); practical points come from the raw earnedPoints sums.
    const writtenWeight = scoring.sections.find((s) => s.part === ExamPart.WRITTEN)?.weight ?? 0;
    const objective = ((session.writtenScore ?? 0) / 100) * writtenWeight;
    const sumPart = (part: ExamPart) =>
      session.essayAnswers
        .filter((a) => a.part === part)
        .reduce((s, a) => s + (a.expertScore ?? a.earnedPoints ?? 0), 0);
    const partB = sumPart(ExamPart.DELIVERABLE);
    const partC = sumPart(ExamPart.ESSAY);
    const practical = sumPart(ExamPart.PRACTICAL);

    const sectionPct = (part: ExamPart): number => {
      if (part === ExamPart.WRITTEN) return session.writtenScore ?? 0;
      const answers = session.essayAnswers.filter((a) => a.part === part);
      const max = answers.reduce((s, a) => s + (taskById.get(a.taskId)?.points ?? 0), 0);
      const earned = answers.reduce((s, a) => s + (a.expertScore ?? a.earnedPoints ?? 0), 0);
      return max > 0 ? (earned / max) * 100 : 0;
    };
    const weighted = computeWeightedResult(scoring, sectionPct);

    // AI-contract facts across the session's answers.
    const answers = session.essayAnswers;
    const vocab = level === CertLevel.L3 ? RISK_VOCAB_L3 : RISK_VOCAB_L1_L2;
    const riskFlags = Array.from(
      new Set(
        answers.flatMap((a) =>
          Array.isArray(a.aiRiskFlags)
            ? (a.aiRiskFlags as Array<{ code?: string }>)
                .map((f) => String(f?.code ?? ''))
                .filter((code) => vocab.includes(code))
            : [],
        ),
      ),
    );
    const criticalFailPatterns = Array.from(
      new Set(
        answers.flatMap((a) =>
          Array.isArray(a.aiCriticalFails)
            ? (a.aiCriticalFails as unknown[])
                .filter((v): v is string => typeof v === 'string')
                .filter((v) =>
                  (CRITICAL_FAIL_PATTERNS[level as 'L1' | 'L2' | 'L3'] as readonly string[]).includes(v),
                )
            : [],
        ),
      ),
    );
    const severityRank = { none: 0, medium: 1, high: 2, critical: 3 } as const;
    let highestSeverity: keyof typeof severityRank = 'none';
    for (const tag of riskFlags) {
      const sev = severityForRiskTag(tag);
      const mapped = sev === 'CRITICAL' ? 'critical' : sev === 'HIGH' ? 'high' : 'medium';
      if (severityRank[mapped] > severityRank[highestSeverity]) highestSeverity = mapped;
    }
    const gateTriggered = answers.some(
      (a) => (a.aiGate as { triggered?: boolean } | null)?.triggered === true,
    );
    const injectionSuspected = answers.some((a) => a.aiInjectionSuspected);
    const confidences = answers.map((a) => a.aiConfidence).filter((c): c is number => c != null);
    const minConfidence = confidences.length ? Math.min(...confidences) : 1;
    const unscoredTask = answers.some((a) => a.expertScore == null && a.earnedPoints == null);

    // v2.0 review bands (WP3) on the point scales.
    const taskScores: TaskScoreV2[] = answers.map((a) => {
      const tpl = taskById.get(a.taskId);
      const practiceType = this.practiceTypeOf(tpl);
      return {
        key: a.taskId,
        score: a.expertScore ?? a.earnedPoints ?? 0,
        max: tpl?.points ?? 0,
        isRiskJudgementType: practiceType.replace(/[\s·]/g, '').includes('리스크판단'),
      };
    });
    const review = sessionReviewV2(level, {
      total: weighted.total,
      objective,
      practice: level === CertLevel.L1 ? partB : practical,
      partC: level === CertLevel.L1 ? partC : undefined,
      taskScores,
      gateTriggered,
      riskFlagged: riskFlags.length > 0,
      criticalRisk: highestSeverity === 'critical',
      criticalFail: criticalFailPatterns.length > 0,
      lowConfidence: minConfidence < GRADING_CONFIG.CONFIDENCE_FLOOR,
      injectionSuspected,
      unscoredTask,
    });
    const below40 = new Set(review.tasksBelow40Pct);

    const decisionStatus = (session.decisionStatus ?? DecisionStatus.PROVISIONAL).toLowerCase();
    const aggregatedAt = new Date();
    const promptVersion =
      answers.map((a) => a.aiPromptVersion).find((v) => v) ??
      AI_GRADING_PROMPT_VERSION[level as 'L1' | 'L2' | 'L3'];
    const rubricVersion = answers.map((a) => a.aiRubricVersion).find((v) => v) ?? 'v1';

    const base = {
      schema_version: '1.0',
      qualification: 'AXIS',
      level,
      applicant_ref: applicantRef(session.userId),
      org_ref: null as string | null,
      risk_assessment: {} as Record<string, unknown>, // per-level below
      review: {} as Record<string, unknown>,
      gate_results: weighted.gateResults,
      decision_status: {
        status: decisionStatus,
        final_decision_owner: 'human_exam_admin_or_review_panel',
        confirmed_at: session.confirmedAt?.toISOString() ?? null,
        confirmed_by_ref: session.confirmedByRef ?? null,
      },
      audit: {
        aggregated_at: aggregatedAt.toISOString(),
        prompt_version: promptVersion,
        rubric_version: rubricVersion,
        exam_snapshot_ref: `exam-snapshot:${session.id}:${session.paperSeed ?? 'unseeded'}`,
      } as Record<string, unknown>,
    };
    const examSession: Record<string, unknown> = {
      exam_session_id: session.id,
      exam_form_id: session.paperSeed ?? session.id,
      submitted_at: (session.submittedAt ?? session.updatedAt).toISOString(),
      exam_time_limit_minutes: timing.totalMinutes,
    };

    let json: Record<string, unknown>;
    let promptLogRef: string | null = null;
    let promptLogHash: string | null = null;

    if (level === CertLevel.L3) {
      const round2 = (n: number) => Math.round(n * 100) / 100;
      json = {
        ...base,
        exam_session: { ...examSession, scoring_run_id: null },
        scores: {
          objective_score: round2(objective),
          practice_score: round2(practical),
          total_score: weighted.total,
        },
        practice_item_refs: answers
          .filter((a) => a.part === ExamPart.PRACTICAL)
          .map((a) => {
            const tpl = taskById.get(a.taskId);
            return {
              item_id: a.taskId,
              practice_type: this.l3PracticeTypeLabel(tpl),
              item_record_id: a.id,
              item_score: a.expertScore ?? a.earnedPoints ?? 0,
            };
          }),
        risk_assessment: {
          risk_flags: riskFlags,
          highest_severity: highestSeverity,
          critical_risk_detected: highestSeverity === 'critical',
        },
        review: {
          human_review_required: review.humanReviewRequired,
          review_reasons: review.reviewReasons,
          min_item_ai_confidence: minConfidence,
        },
        audit: { ...base.audit, item_schema_version: '1.0' },
      };
    } else if (level === CertLevel.L2) {
      // Prompt-log audit (WP5): hash the full applicant↔embedded-AI transcript.
      const logs = answers
        .filter((a) => a.aiChatLog != null)
        .sort((a, b) => a.taskId.localeCompare(b.taskId))
        .map((a) => ({ taskId: a.taskId, log: a.aiChatLog }));
      promptLogRef = `essay-answers:${session.id}:ai_chat_log`;
      promptLogHash = sha256(JSON.stringify(logs));
      const taskRefs = answers
        .filter((a) => a.part === ExamPart.PRACTICAL)
        .sort(
          (a, b) =>
            (taskById.get(a.taskId)?.orderIndex ?? 0) - (taskById.get(b.taskId)?.orderIndex ?? 0),
        )
        .map((a) => {
          const tpl = taskById.get(a.taskId);
          return {
            task_id: a.taskId,
            practice_type: this.practiceTypeOf(tpl) || tpl?.title || 'unknown',
            task_record_id: a.id,
            task_score: a.expertScore ?? a.earnedPoints ?? 0,
            below_40_percent: below40.has(a.taskId),
          };
        });
      // task_A/B/C in paper order (orderIndex).
      const keyed: Record<string, number> = {};
      (['task_A', 'task_B', 'task_C'] as const).forEach((k, i) => {
        keyed[k] = taskRefs[i]?.task_score ?? 0;
      });
      json = {
        ...base,
        exam_session: {
          ...examSession,
          embedded_ai_version:
            session.embeddedAiVersion ?? process.env.EMBEDDED_AI_VERSION ?? 'unspecified',
          prompt_log_ref: session.promptLogRef ?? promptLogRef,
        },
        scores: {
          objective_score: Math.round(objective * 100) / 100,
          practice_score: Math.round(practical * 100) / 100,
          practice_task_scores: keyed,
          total_score: weighted.total,
        },
        practice_task_refs: taskRefs,
        risk_assessment: {
          risk_flags: riskFlags,
          critical_fail_detected: criticalFailPatterns.length > 0,
          critical_fail_patterns: criticalFailPatterns,
        },
        review: {
          human_review_required: review.humanReviewRequired,
          review_reasons: review.reviewReasons,
          min_task_ai_confidence: minConfidence,
        },
        audit: { ...base.audit, prompt_log_hash: session.promptLogHash ?? promptLogHash },
      };
    } else {
      json = {
        ...base,
        exam_session: {
          ...examSession,
          ai_use_blocked: true,
          // Similarity screening (기획서 v2.0: 채점 전 제출물 간 유사도 검사)
          // runs out-of-band; this ref names where its result is filed.
          similarity_check_ref: `similarity:${session.id}`,
        },
        scores: {
          part_a_score: Math.round(objective * 100) / 100,
          part_b_score: partB,
          part_c_score: partC,
          total_score: weighted.total,
        },
        part_record_refs: (() => {
          let essaySeen = 0;
          return answers.map((a) => ({
            part:
              a.part === ExamPart.DELIVERABLE
                ? 'B'
                : a.part === ExamPart.ESSAY
                  ? (essaySeen++ === 0 ? 'C1' : 'C2')
                  : 'A',
            record_id: a.id,
          }));
        })(),
        risk_assessment: {
          risk_flags: riskFlags,
          critical_fail_detected: criticalFailPatterns.length > 0,
          critical_fail_patterns: criticalFailPatterns,
        },
        review: {
          human_review_required: review.humanReviewRequired,
          review_reasons: review.reviewReasons,
          min_ai_confidence: minConfidence,
        },
      };
    }

    return {
      json,
      decisionStatus,
      humanReviewRequired: review.humanReviewRequired,
      internalReasons: review.internalReasons,
      aggregatedAt,
      promptLogRef,
      promptLogHash,
    };
  }

  /** Practice type from the task rubric wrapper (seed practiceType) or taskType column. */
  private practiceTypeOf(tpl: TaskTemplate | undefined): string {
    if (!tpl) return '';
    const l3 = parseL3Reference(tpl.rubric);
    return l3?.practiceType ?? tpl.taskType ?? '';
  }

  /** Canonical bank type → the L3 schema enum spelling (분석검증형 → 분석·검증형 …). */
  private l3PracticeTypeLabel(tpl: TaskTemplate | undefined): string {
    const raw = this.practiceTypeOf(tpl).replace(/[\s·]/g, '');
    return L3_PRACTICE_TYPE_LABELS[raw] ?? this.practiceTypeOf(tpl) ?? '현업적용형';
  }
}

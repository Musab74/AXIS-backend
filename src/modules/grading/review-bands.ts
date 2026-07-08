/**
 * 시험 표준 v2.0 경계밴드/검수 트리거 (WP3).
 *
 * v1.1 was a generic ±BOUNDARY_BAND_PCT window around each pass cut; v2.0
 * replaces it with EXPLICIT per-level score bands, and the fired reasons must
 * be the exact enum strings of the level's session-aggregate schema
 * (AXIS_L*_채점_세션집계_JSON스키마_v1_0.json) so the aggregate record
 * validates. All cutoffs live in REVIEW_BANDS_V2 — never inline them.
 *
 * Pure functions only (no Nest DI / DB) so the band matrix is unit-testable.
 */
import { CertLevel } from '@prisma/client';

/** Inclusive score band [min, max] on the level's point scale. */
export interface ScoreBand {
  min: number;
  max: number;
}

const inBand = (score: number, band: ScoreBand): boolean =>
  score >= band.min && score <= band.max;

/**
 * v2.0 review-reason enum strings — verbatim from each level's
 * 채점_세션집계_JSON스키마_v1_0.json `review.review_reasons.items.enum`.
 * Do NOT reword: the aggregate record is schema-validated against these.
 */
export const REVIEW_REASONS_V2 = {
  L3: {
    TOTAL_BAND: '총점 경계권(65~74)',
    PRACTICE_BAND: '실습형 경계밴드(22~26)',
    PRACTICE_BELOW_MIN: '실습형 최저기준 미달(24 미만)',
    OBJECTIVE_BELOW_MIN: '객관식 최저기준 미달(30 미만)',
    RISK_TASK_LOW: '리스크 판단형 5점 이하',
    GATE_TRIGGERED: '게이트 발동 문항 존재',
    RISK_FLAG: '위험 플래그',
    CRITICAL_RISK: 'critical 위험',
    LOW_CONFIDENCE: 'confidence 0.75 미만 문항 존재',
    INJECTION: '인젝션 의심',
    APPEAL: '이의신청',
  },
  L2: {
    TOTAL_BAND: '총점 경계권(65~74)',
    OBJECTIVE_BAND: '객관식 경계밴드(13~17)',
    PRACTICE_BAND: '실습형 경계밴드(38~45)',
    OBJECTIVE_BELOW_MIN: '객관식 최저기준 미달(15 미만)',
    PRACTICE_BELOW_MIN: '실습형 최저기준 미달(42 미만)',
    TASK_BELOW_40PCT: '단일 과제 40% 미만',
    GATE_TRIGGERED: '산출물-검증 게이트 발동',
    CRITICAL_FAIL: '치명 실패 패턴',
    RISK_FLAG: '위험 플래그',
    LOW_CONFIDENCE: 'confidence 0.75 미만 과제 존재',
    INJECTION: '인젝션 의심',
    APPEAL: '이의신청',
  },
  L1: {
    TOTAL_BAND: '총점 경계권(65~74)',
    PART_A_BAND: 'Part A 경계밴드(11~15)',
    PART_B_BAND: 'Part B 경계밴드(30~36)',
    PART_A_BELOW_MIN: 'Part A 최저기준 미달(13 미만)',
    PART_B_BELOW_MIN: 'Part B 최저기준 미달(33 미만)',
    // v1.1 schema (2026-07-06): Part C < 12 is now an OFFICIAL review reason
    // (Part C has no hard floor — this is a weakness indicator, not a fail).
    PART_C_LOW: 'Part C 검수 기준(12 미만)',
    GATE_TRIGGERED: '계획-리스크 게이트 발동',
    CRITICAL_FAIL: '치명 실패 패턴',
    RISK_FLAG: '위험 플래그',
    LOW_CONFIDENCE: 'confidence 0.75 미만',
    SIMILARITY_TOP: '제출물 유사도 상위',
    APPEAL: '이의신청',
  },
} as const;

/**
 * Internal-only review reasons still exist as a mechanism (they set
 * `human_review_required` but are NOT in a schema enum, so the aggregation
 * service keeps them out of the validated `review_reasons` array). Currently
 * only "미채점 과제 존재" uses it — the L1 Part C < 12 reason graduated to an
 * OFFICIAL schema enum string in the v1.1 schema (see REVIEW_REASONS_V2.L1).
 */

/**
 * v2.0 boundary/trigger cutoffs per level, on each level's POINT scale
 * (총점 0–100; sections on their own max). Provisional per the spec — tune
 * here, never at call sites.
 */
export const REVIEW_BANDS_V2 = {
  L3: {
    totalBand: { min: 65, max: 74 } as ScoreBand,
    practiceBand: { min: 22, max: 26 } as ScoreBand,
    practiceMin: 24, // hard cut 24/40 (below → fail; band 22–26 reviews first)
    objectiveMin: 30, // hard cut 30/60 — v2.0 신설
    /** 리스크 판단형 문항 합계 ≤ 5점 → 검수 (위험한 고활용자 검토). */
    riskTaskReviewMax: 5,
  },
  L2: {
    totalBand: { min: 65, max: 74 } as ScoreBand,
    objectiveBand: { min: 13, max: 17 } as ScoreBand,
    practiceBand: { min: 38, max: 45 } as ScoreBand,
    objectiveMin: 15, // hard cut 15/30
    practiceMin: 42, // hard cut 42/70
    /** 단일 과제 40% 미만 플래그: A<10/25, B<10/25, C<8/20. */
    taskFloorPctBelow: 40,
  },
  L1: {
    totalBand: { min: 65, max: 74 } as ScoreBand,
    partABand: { min: 11, max: 15 } as ScoreBand,
    partBBand: { min: 30, max: 36 } as ScoreBand,
    partAMin: 13, // hard cut 13/25 — v2.0 신설
    partBMin: 33, // hard cut 33/55
    /** Part C weakness indicator — review only, never an automatic fail. */
    partCReviewBelow: 12,
  },
} as const;

/** One practical task/item score on its own point scale (for per-task flags). */
export interface TaskScoreV2 {
  /** L2: 'task_A'|'task_B'|'task_C'; L3: practice_type or task id. */
  key: string;
  score: number;
  max: number;
  /** L3: set true on the 리스크 판단형 item so its low-score trigger fires. */
  isRiskJudgementType?: boolean;
}

/** Session-level facts the band evaluation needs (all on point scales). */
export interface SessionReviewInputV2 {
  /** Weighted 0–100 total. */
  total: number;
  /** 객관식 점수 — L3 0–60 / L2 0–30 / L1 Part A 0–25. */
  objective: number;
  /** 실습·산출물 점수 — L3 0–40 / L2 0–70 / L1 Part B 0–55. */
  practice: number;
  /** L1 Part C 서술형 0–20 (ignored for L2/L3). */
  partC?: number;
  /** Per-task scores for single-task flags / L3 risk-type trigger. */
  taskScores?: TaskScoreV2[];
  /** Any AI gate candidate on the session (선택-근거/산출물-검증/계획-리스크). */
  gateTriggered?: boolean;
  /** Any controlled-vocabulary risk flag present. */
  riskFlagged?: boolean;
  /** Critical-severity risk detected (L3: 개인정보/기밀정보 입력). */
  criticalRisk?: boolean;
  /** Any critical-fail pattern candidate (L1/L2). */
  criticalFail?: boolean;
  /** Min AI confidence across tasks < CONFIDENCE_FLOOR. */
  lowConfidence?: boolean;
  injectionSuspected?: boolean;
  appealFiled?: boolean;
  /** L1: similarity check top-N hit. */
  similarityTop?: boolean;
  /** Any task left unscored (AI fallback / missing grade). */
  unscoredTask?: boolean;
}

export interface SessionReviewResultV2 {
  humanReviewRequired: boolean;
  /** Schema-enum reasons, deduped, in stable order. */
  reviewReasons: string[];
  /** Reasons that set the flag but are not in the schema enum (kept off the aggregate's review_reasons). */
  internalReasons: string[];
  /** L2: task keys whose score fell below 40% of the task max. */
  tasksBelow40Pct: string[];
}

/**
 * Evaluates the v2.0 per-level review bands. Returns the exact schema enum
 * strings; the caller (aggregation service / prescore dispatcher) persists
 * them and ORs `humanReviewRequired` into `mandatoryReview`.
 */
export function sessionReviewV2(
  level: CertLevel,
  input: SessionReviewInputV2,
): SessionReviewResultV2 {
  const reasons: string[] = [];
  const internal: string[] = [];
  const tasksBelow40Pct: string[] = [];
  const push = (r: string) => {
    if (!reasons.includes(r)) reasons.push(r);
  };

  if (level === CertLevel.L3) {
    const b = REVIEW_BANDS_V2.L3;
    const R = REVIEW_REASONS_V2.L3;
    if (inBand(input.total, b.totalBand)) push(R.TOTAL_BAND);
    if (inBand(input.practice, b.practiceBand)) push(R.PRACTICE_BAND);
    if (input.practice < b.practiceMin) push(R.PRACTICE_BELOW_MIN);
    if (input.objective < b.objectiveMin) push(R.OBJECTIVE_BELOW_MIN);
    for (const t of input.taskScores ?? []) {
      if (t.isRiskJudgementType && t.score <= b.riskTaskReviewMax) push(R.RISK_TASK_LOW);
    }
    if (input.gateTriggered) push(R.GATE_TRIGGERED);
    if (input.riskFlagged) push(R.RISK_FLAG);
    if (input.criticalRisk) push(R.CRITICAL_RISK);
    if (input.lowConfidence) push(R.LOW_CONFIDENCE);
    if (input.injectionSuspected) push(R.INJECTION);
    if (input.appealFiled) push(R.APPEAL);
  } else if (level === CertLevel.L2) {
    const b = REVIEW_BANDS_V2.L2;
    const R = REVIEW_REASONS_V2.L2;
    if (inBand(input.total, b.totalBand)) push(R.TOTAL_BAND);
    if (inBand(input.objective, b.objectiveBand)) push(R.OBJECTIVE_BAND);
    if (inBand(input.practice, b.practiceBand)) push(R.PRACTICE_BAND);
    if (input.objective < b.objectiveMin) push(R.OBJECTIVE_BELOW_MIN);
    if (input.practice < b.practiceMin) push(R.PRACTICE_BELOW_MIN);
    for (const t of input.taskScores ?? []) {
      if (t.max > 0 && (t.score / t.max) * 100 < b.taskFloorPctBelow) {
        tasksBelow40Pct.push(t.key);
        push(R.TASK_BELOW_40PCT);
      }
    }
    if (input.gateTriggered) push(R.GATE_TRIGGERED);
    if (input.criticalFail) push(R.CRITICAL_FAIL);
    if (input.riskFlagged) push(R.RISK_FLAG);
    if (input.lowConfidence) push(R.LOW_CONFIDENCE);
    if (input.injectionSuspected) push(R.INJECTION);
    if (input.appealFiled) push(R.APPEAL);
  } else {
    const b = REVIEW_BANDS_V2.L1;
    const R = REVIEW_REASONS_V2.L1;
    if (inBand(input.total, b.totalBand)) push(R.TOTAL_BAND);
    if (inBand(input.objective, b.partABand)) push(R.PART_A_BAND);
    if (inBand(input.practice, b.partBBand)) push(R.PART_B_BAND);
    if (input.objective < b.partAMin) push(R.PART_A_BELOW_MIN);
    if (input.practice < b.partBMin) push(R.PART_B_BELOW_MIN);
    if (input.partC != null && input.partC < b.partCReviewBelow) {
      // v1.1: now an official schema enum string (no longer an internal reason).
      push(R.PART_C_LOW);
    }
    if (input.gateTriggered) push(R.GATE_TRIGGERED);
    if (input.criticalFail) push(R.CRITICAL_FAIL);
    if (input.riskFlagged) push(R.RISK_FLAG);
    if (input.lowConfidence) push(R.LOW_CONFIDENCE);
    if (input.similarityTop) push(R.SIMILARITY_TOP);
    if (input.appealFiled) push(R.APPEAL);
  }

  // Unscored task: mandatory review at every level (kept internal — the
  // aggregate schemas have no enum string for it; the AI-fallback reason lives
  // on the item record instead).
  if (input.unscoredTask) internal.push('미채점 과제 존재');

  return {
    humanReviewRequired: reasons.length > 0 || internal.length > 0,
    reviewReasons: reasons,
    internalReasons: internal,
    tasksBelow40Pct,
  };
}

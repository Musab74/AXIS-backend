import type {
  EssayGradeGate,
  EssayGradeRiskFlag,
} from '../../integrations/anthropic/claude-essay-grader.service';
import type { RubricCriterion } from './rubric';

/**
 * v2.0 rubric extensions (WP9 — 루브릭 v2.1 템플릿): a deterministic criterion
 * scored from the generated text (요청문/수정 지시문) rather than a selection
 * field. 'prompt_quality' = keyword coverage vs the answer key's example
 * prompt; 'verification_request' = presence of a 검증/점검 요청.
 */
export interface L3GeneratedCriterion {
  label: string;
  points: number;
  kind: 'prompt_quality' | 'verification_request';
}

/** Parsed L3 rubric wrapper (see prisma/seed-l3-practicals.ts). */
export interface L3RubricPayload {
  answerKey: Record<string, unknown> | null;
  criteria: RubricCriterion[];
  responseFormat: Record<string, unknown> | null;
  /**
   * v2.0 (WP9): per-field points for the objective selections — the
   * per-criterion splits of the 루브릭 v2.1 템플릿 (e.g. 현업적용형
   * {tasks: 4, excluded_materials: 1, review_point: 1}). Null on v1.1 items →
   * legacy even split across answer-key fields.
   */
  fieldPoints: Record<string, number> | null;
  /**
   * v2.0 (WP9): penalty-based 위험통제 criterion (현업적용형) — starts at
   * `points`, minus `penaltyPerHit` per must-not-choose selection, floor 0.
   */
  riskControl: { points: number; penaltyPerHit: number } | null;
  /** v2.0 (WP9): criteria scored from the generated text (지시 보완 등). */
  generatedCriteria: L3GeneratedCriterion[] | null;
  /** v2.0: option codes whose selection deducts points + raises a flag. */
  mustNotChoose: string[];
  /**
   * Item-author expert-review conditions (free-form Korean from the source
   * YAML). Not machine-interpretable — surfaced to the reviewer UI and kept
   * alongside the generic runtime triggers in assessRisk.
   */
  expertReviewTrigger: unknown;
}

/** A candidate's structured L3 answer, decoded from EssayAnswer.contentText JSON. */
export interface L3Submission {
  /** Objective answers keyed by answerKey field name (arrays or single strings). */
  selections: Record<string, unknown>;
  /** The 80–150자 rationale (short_reason). */
  rationale: string;
  /** 지시설계형 write_prompt, when present. */
  promptText: string | null;
  raw: Record<string, unknown>;
}

export interface L3GradeDetail {
  key: string;
  kind: 'objective' | 'rationale' | 'generated' | 'risk_control';
  points: number;
  earned: number;
  matchRatio: number;
  note?: string;
}

export interface L3GradeResult {
  earnedPoints: number;
  pct: number;
  breakdown: {
    objectiveScore: number;
    rationaleScore: number;
    details: L3GradeDetail[];
  };
  riskFlags: EssayGradeRiskFlag[];
  /**
   * 선택-근거 일치 게이트 (v2.0 WP6): the deterministic contradiction
   * heuristic OR the Claude assist can set `triggered`; zeroing the affected
   * selection field is an expert-confirmed action, never automatic.
   */
  gate: EssayGradeGate;
  needsExpertReview: boolean;
  /** Rationale sits in the ambiguous band — worth a later Claude second opinion. */
  needsClaudeRationaleAssist: boolean;
}

export interface L3GradeTask {
  points: number;
  rubric: unknown;
}

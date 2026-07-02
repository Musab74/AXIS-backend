import type { EssayGradeRiskFlag } from '../../integrations/anthropic/claude-essay-grader.service';
import type { RubricCriterion } from './rubric';

/** Parsed L3 rubric wrapper (see prisma/seed-l3-practicals.ts). */
export interface L3RubricPayload {
  answerKey: Record<string, unknown> | null;
  criteria: RubricCriterion[];
  responseFormat: Record<string, unknown> | null;
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
  kind: 'objective' | 'rationale';
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
  needsExpertReview: boolean;
  /** Rationale sits in the ambiguous band — worth a later Claude second opinion. */
  needsClaudeRationaleAssist: boolean;
}

export interface L3GradeTask {
  points: number;
  rubric: unknown;
}

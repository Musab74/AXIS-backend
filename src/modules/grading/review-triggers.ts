/**
 * Pure mandatory-review / dispute predicates shared by the AI prescore
 * dispatcher (EssayGradingService) and the admin grading queue
 * (AdminGradingService). Kept side-effect free so they can be unit-tested
 * without Nest DI or a database.
 */
import { ExamPart } from '@prisma/client';
import { computeWeightedResult, LevelScoring } from '../cbtSessions/exam-spec';
import { GRADING_CONFIG } from './grading-config';

/** One AI-graded task outcome, reduced to the fields the review triggers need. */
export interface ReviewTriggerInput {
  scored: boolean;
  /** Hard override set by a grader (L3 legacy free-text, Judge0-less code task…). */
  forceReview?: boolean;
  pct?: number;
  band?: string;
  confidence?: number;
  /** Count of risk flags on the task. */
  riskFlags?: number;
  /** Section floor (%) for the task's exam part — null when the section has no floor. */
  floorPct?: number | null;
}

/**
 * Mandatory expert-review triggers for ONE task. Numeric triggers are applied
 * on top of the AI's self-reported band/confidence so a miscalibrated model
 * cannot skip review by labelling a failing score "normal":
 *   - confidence < CONFIDENCE_FLOOR
 *   - any risk flag
 *   - band borderline/fail
 *   - pct < TASK_REVIEW_FLOOR_PCT (all levels)
 *   - pct below the section floor, or within ±BOUNDARY_BAND_PCT of it
 */
export function taskTriggersReview(o: ReviewTriggerInput): boolean {
  if (o.forceReview === true) return true;
  if (!o.scored) return false;
  if (o.confidence != null && o.confidence < GRADING_CONFIG.CONFIDENCE_FLOOR) return true;
  if ((o.riskFlags ?? 0) > 0) return true;
  if (o.band === 'borderline' || o.band === 'fail') return true;
  if (o.pct == null) return false;
  if (o.pct < GRADING_CONFIG.TASK_REVIEW_FLOOR_PCT) return true;
  const floor = o.floorPct;
  if (floor != null && (o.pct < floor || Math.abs(o.pct - floor) <= GRADING_CONFIG.BOUNDARY_BAND_PCT)) {
    return true;
  }
  return false;
}

/** Session-level `mandatoryReview` from the per-task outcomes. */
export function computeMandatoryReview(outcomes: ReviewTriggerInput[]): boolean {
  return outcomes.some(taskTriggersReview);
}

/** One non-written section's aggregate percentage + its floor. */
export interface SectionPctInput {
  part: ExamPart;
  pct: number;
  floorPct: number | null;
}

/**
 * Session-level review triggers (L2 §: total 65–74; practical 38–45/70 —
 * generalized as the ±band window around passTotal / each section floor, plus
 * any section below its floor).
 */
export function sessionTriggersReview(
  passTotal: number,
  totalScore: number,
  sections: SectionPctInput[],
): boolean {
  const band = GRADING_CONFIG.BOUNDARY_BAND_PCT;
  if (totalScore >= passTotal - band && totalScore < passTotal + band) return true;
  return sections.some(
    (s) => s.floorPct != null && (s.pct < s.floorPct || Math.abs(s.pct - s.floorPct) <= band),
  );
}

/**
 * Session-level review check from per-task AI percentages: aggregates each
 * non-written section, computes the weighted total with the level's scoring
 * model, and applies `sessionTriggersReview`. `pctByTask` maps taskId → AI pct.
 */
export function sessionReviewFromTaskPcts(
  scoring: LevelScoring,
  writtenPct: number,
  tasks: Array<{ id: string; part: ExamPart; points: number }>,
  pctByTask: ReadonlyMap<string, number>,
): boolean {
  const agg = new Map<ExamPart, { earned: number; total: number }>();
  for (const t of tasks) {
    const a = agg.get(t.part) ?? { earned: 0, total: 0 };
    a.total += t.points;
    a.earned += ((pctByTask.get(t.id) ?? 0) / 100) * t.points;
    agg.set(t.part, a);
  }
  const sectionPct = (part: ExamPart): number => {
    if (part === ExamPart.WRITTEN) return writtenPct;
    const a = agg.get(part);
    return a && a.total > 0 ? Math.round((a.earned / a.total) * 100) : 0;
  };
  const { total } = computeWeightedResult(scoring, sectionPct);
  const sections: SectionPctInput[] = scoring.sections
    .filter((s) => s.part !== ExamPart.WRITTEN)
    .map((s) => ({ part: s.part, pct: sectionPct(s.part), floorPct: s.floorPct }));
  return sessionTriggersReview(scoring.passTotal, total, sections);
}

/**
 * True when the expert's score and the AI pre-score disagree by
 * ≥ DISPUTE_DELTA_POINTS once both sit on the same 0–100 scale.
 *
 * `expertScore` is RAW task points (0..taskPoints); `aiPreScorePct` is the
 * persisted AI percentage. Comparing them without normalizing was the source
 * of the false `expert_disputed` states this replaces.
 */
export function isScoreDisputed(
  expertScore: number | null,
  aiPreScorePct: number | null,
  taskPoints: number | null | undefined,
): boolean {
  if (expertScore == null || aiPreScorePct == null) return false;
  if (taskPoints == null || taskPoints <= 0) return false;
  const expertPct = (expertScore / taskPoints) * 100;
  return Math.abs(expertPct - aiPreScorePct) >= GRADING_CONFIG.DISPUTE_DELTA_POINTS;
}

/** Severities that escalate finalize authority to a GRADING_ADMIN (AXIS-H ladder). */
export const ESCALATED_SEVERITIES: ReadonlySet<string> = new Set(['HIGH', 'CRITICAL']);

/** True when a persisted `aiRiskFlags` JSON value contains a HIGH/CRITICAL flag. */
export function hasEscalatedRiskFlags(riskFlagsJson: unknown): boolean {
  if (!Array.isArray(riskFlagsJson)) return false;
  return riskFlagsJson.some((f) => {
    const severity = (f as { severity?: unknown } | null)?.severity;
    return typeof severity === 'string' && ESCALATED_SEVERITIES.has(severity.toUpperCase());
  });
}

/** True when any answer in the session carries an escalated (HIGH/CRITICAL) flag. */
export function anyAnswerEscalated(answers: Array<{ aiRiskFlags: unknown }>): boolean {
  return answers.some((a) => hasEscalatedRiskFlags(a.aiRiskFlags));
}

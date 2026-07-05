/**
 * Hybrid-grading thresholds — the config-table stand-in.
 *
 * The original AXIS L1 brief sourced these from a `공통설정` (common-settings)
 * YAML and spoke in absolute cut lines (70/100 pass, 39/33 Part-B cuts, 12
 * Part-C floor). That content does NOT exist in this repo: the live platform
 * grades on percentages via `LEVEL_TIMING` (written ≥60 AND practical ≥60,
 * per-subject ≥40). To honour the brief's "load thresholds, never hardcode in
 * scattered literals" rule without inventing a fictional cut scheme, every
 * tunable used by the AI scorer / calibration / review-trigger logic lives here
 * in one place. If a real settings table is added later, swap the reads — the
 * call sites already treat these as injected config, not magic numbers.
 */
export const GRADING_CONFIG = {
  /**
   * Minimum AI self-reported confidence for an AI pre-score to be considered
   * trustworthy. Below this, the session is forced to human adjudication and a
   * task cannot pass calibration. (Brief §5: "AI confidence < 0.75".)
   */
  CONFIDENCE_FLOOR: 0.75,

  /**
   * Gap between the expert's score and the AI pre-score — both normalized to a
   * 0–100 percentage of the task's max points — at or beyond which a task is
   * treated as disputed (drives the `expert_disputed` queue state).
   */
  DISPUTE_DELTA_POINTS: 15,

  /**
   * Pass-boundary band, in percentage points around a section's pass line,
   * within which a result is "borderline" and must be human-reviewed. Replaces
   * the brief's literal 65–74 total-score window (which assumed a 0–100 point
   * total this platform does not use). Default ±5pp around each pass cut.
   */
  BOUNDARY_BAND_PCT: 5,

  /**
   * Calibration tolerance: the AI's total on an anchor exemplar must fall
   * within `max(expertVariance, CALIBRATION_FLOOR_POINTS)` points of the expert
   * mean. The floor guards the case where experts agree perfectly (variance 0)
   * but we still allow the AI a small slack.
   */
  CALIBRATION_FLOOR_POINTS: 3,

  /** Minimum number of independent expert ratings required to calibrate a task. */
  CALIBRATION_MIN_EXPERTS: 2,

  /**
   * Per-task hard review floor (%): any practical/essay task scored below this
   * percentage goes to mandatory expert review regardless of the AI's
   * band/confidence self-report. Applies at every level.
   */
  TASK_REVIEW_FLOOR_PCT: 40,
} as const;

/**
 * CRITICAL is reserved for the AXIS-H medical ruleset (치료·처방·환자정보 —
 * 불합격 검토 대상). Any HIGH or CRITICAL flag escalates finalize to a
 * GRADING_ADMIN (see review-triggers.ts).
 */
export type RiskSeverity = 'LOW' | 'MED' | 'HIGH' | 'CRITICAL';

export type GradingBand = 'excellent' | 'normal' | 'borderline' | 'fail';

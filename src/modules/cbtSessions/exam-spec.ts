import { CertLevel, CertType, ExamPart } from '@prisma/client';

export interface LevelTiming {
  totalMinutes: number;
  writtenMinutes: number;
  practicalMinutes: number;
  /** @deprecated L1/L2 now pass on the weighted 100-pt total (see LEVEL_SCORING). Kept for L3 (written-only) and legacy reads. */
  passWritten: number;
  /** @deprecated see passWritten */
  passPractical: number | null;
  subjectFailPct: number;
}

/**
 * One scorable section of an exam, expressed in the spec's weighted 100-point
 * model (AXIS Assessment Master Guideline §4-4 / §6-8). `weight` is the
 * section's contribution to the 100-point total; `floorPct` is the section
 * minimum (과락) as a percentage of that section's own max — null = no floor.
 */
export interface SectionScoring {
  part: ExamPart;
  weight: number;
  floorPct: number | null;
}

export interface LevelScoring {
  /** Overall pass score out of 100 (spec: 70 for L1/L2). */
  passTotal: number;
  sections: SectionScoring[];
}

export interface LevelExamSpec {
  timing: LevelTiming;
  /** Number of MCQ questions to draw for the written section */
  writtenQuestionCount: number;
  /** Number of practical tasks to include (0 for L3) */
  practicalTaskCount: number;
  /** Total questions in the question bank pool for this level */
  poolSize: number;
  /** Subject distribution for question selection (subjectIndex -> count) */
  subjectDistribution?: Record<number, number>;
}

/**
 * Base timing per level (AXIS / AXIS-H). Series-specific divergences live in
 * CERT_TIMING_OVERRIDES — read through `getTiming(certType, level)`, never this
 * map directly, so AXIS-C's longer L2 is always applied.
 */
export const LEVEL_TIMING: Record<CertLevel, LevelTiming> = {
  L3: { totalMinutes: 60, writtenMinutes: 60, practicalMinutes: 0, passWritten: 60, passPractical: null, subjectFailPct: 40 },
  L2: { totalMinutes: 90, writtenMinutes: 30, practicalMinutes: 60, passWritten: 60, passPractical: 60, subjectFailPct: 40 },
  L1: { totalMinutes: 120, writtenMinutes: 30, practicalMinutes: 90, passWritten: 60, passPractical: 60, subjectFailPct: 40 },
};

/**
 * Per-series timing overrides. Spec: AXIS-C L2 runs 120 minutes (coding/automation
 * tasks need more time) vs 90 for AXIS/AXIS-H.
 */
const CERT_TIMING_OVERRIDES: Partial<Record<CertType, Partial<Record<CertLevel, Partial<LevelTiming>>>>> = {
  AXIS_C: {
    L2: { totalMinutes: 120, practicalMinutes: 90 },
  },
};

/**
 * Reads `L3_PRACTICALS_ENABLED` at the call site (not module-load) so toggling
 * the env var in tests/dev does not require a server restart. The flag flips
 * L3 from MCQ-only → MCQ + 4 실습형 per the new 운영기획서:
 *   60 min written + 20 min practical = 80 min total,
 *   100 점 (객관식 60 + 실습형 40), pass 70, practical floor 60% (24/40).
 * In-flight sessions are unaffected because their paper is already frozen at
 * `/cbt/sessions/:id/start`.
 */
function isL3PracticalsEnabled(): boolean {
  return (process.env.L3_PRACTICALS_ENABLED || 'false').toLowerCase() === 'true';
}

const L3_TIMING_WITH_PRACTICALS: LevelTiming = {
  totalMinutes: 80,
  writtenMinutes: 60,
  practicalMinutes: 20,
  passWritten: 60,
  passPractical: 60,
  subjectFailPct: 40,
};

export function getTiming(certType: CertType, level: CertLevel): LevelTiming {
  let base = LEVEL_TIMING[level];
  if (level === 'L3' && isL3PracticalsEnabled()) {
    base = L3_TIMING_WITH_PRACTICALS;
  }
  const override = CERT_TIMING_OVERRIDES[certType]?.[level];
  return override ? { ...base, ...override } : base;
}

/**
 * Weighted 100-point scoring + section floors per the spec.
 *   L3: written-only (graded immediately; kept here for completeness).
 *   L2: MC 30 + practical 70, pass 70; floors MC ≥50% (15/30), practical ≥60% (42/70).
 *   L1: MC 25 + exec-plan 55 + essay 20, pass 70; floors exec-plan ≥60% (33/55), essay ≥60% (12/20).
 */
export const LEVEL_SCORING: Record<CertLevel, LevelScoring> = {
  L3: {
    passTotal: 60,
    sections: [{ part: ExamPart.WRITTEN, weight: 100, floorPct: null }],
  },
  L2: {
    passTotal: 70,
    sections: [
      { part: ExamPart.WRITTEN, weight: 30, floorPct: 50 },
      { part: ExamPart.PRACTICAL, weight: 70, floorPct: 60 },
    ],
  },
  L1: {
    passTotal: 70,
    sections: [
      { part: ExamPart.WRITTEN, weight: 25, floorPct: null },
      { part: ExamPart.DELIVERABLE, weight: 55, floorPct: 60 },
      { part: ExamPart.ESSAY, weight: 20, floorPct: 60 },
    ],
  },
};

/**
 * When `L3_PRACTICALS_ENABLED=true`, L3 follows the new 운영기획서:
 *   passTotal 70, written weight 60 (no floor), practical weight 40,
 *   practical floor 60% (실습형 24/40 미만 → 경계검수/불합격 검토).
 */
const L3_SCORING_WITH_PRACTICALS: LevelScoring = {
  passTotal: 70,
  sections: [
    { part: ExamPart.WRITTEN, weight: 60, floorPct: null },
    { part: ExamPart.PRACTICAL, weight: 40, floorPct: 60 },
  ],
};

// Scoring is currently uniform across series; the certType param keeps call
// sites future-proof for a per-series override (mirrors getTiming).
export function getScoring(_certType: CertType, level: CertLevel): LevelScoring {
  if (level === 'L3' && isL3PracticalsEnabled()) {
    return L3_SCORING_WITH_PRACTICALS;
  }
  return LEVEL_SCORING[level];
}

export interface WeightedResult {
  /** 0–100 weighted total, rounded. */
  total: number;
  /** True iff total ≥ passTotal AND every section clears its floor. */
  passed: boolean;
  /** Sections that fell below their floor (과락). */
  floorFailures: ExamPart[];
}

/**
 * Pure weighted-100 scorer shared by the finalize path and the smoke test.
 * `sectionPct(part)` returns that section's score as a percentage of its own
 * max (0–100). Pass requires the weighted total to clear `passTotal` AND every
 * section with a floor to clear it.
 */
export function computeWeightedResult(
  scoring: LevelScoring,
  sectionPct: (part: ExamPart) => number,
): WeightedResult {
  let weightedTotal = 0;
  const floorFailures: ExamPart[] = [];
  for (const sec of scoring.sections) {
    const pct = sectionPct(sec.part);
    weightedTotal += (pct / 100) * sec.weight;
    if (sec.floorPct != null && pct < sec.floorPct) {
      floorFailures.push(sec.part);
    }
  }
  const total = Math.round(weightedTotal);
  return { total, passed: total >= scoring.passTotal && floorFailures.length === 0, floorFailures };
}

export const LEVEL_EXAM_SPEC: Record<CertLevel, LevelExamSpec> = {
  L3: {
    timing: LEVEL_TIMING.L3,
    writtenQuestionCount: 40,
    practicalTaskCount: 0,
    poolSize: 200,
    subjectDistribution: { 0: 12, 1: 12, 2: 8, 3: 8 }, // 40 total from 4 subjects (scaled 50→40)
  },
  L2: {
    timing: LEVEL_TIMING.L2,
    writtenQuestionCount: 30,
    practicalTaskCount: 3,
    poolSize: 120,
    subjectDistribution: { 0: 15, 1: 10, 2: 5 }, // 30 total from 3 subjects
  },
  L1: {
    timing: LEVEL_TIMING.L1,
    writtenQuestionCount: 25, // Part A: 25 MCQ (spec §8-1)
    practicalTaskCount: 3, // 1 exec-plan (DELIVERABLE) + 2 essays (ESSAY)
    poolSize: 100,
    subjectDistribution: { 0: 15, 1: 10 }, // 25 total from 2 subjects (AX Strategy 15Q, AI Governance & Risk 10Q)
  },
};

export function getExamSpec(certType: CertType, level: CertLevel): LevelExamSpec {
  const base = LEVEL_EXAM_SPEC[level];
  // L3 flag flip: 4 실습형(층화 1/유형) on top of the 40 MCQ.
  const practicalTaskCount =
    level === 'L3' && isL3PracticalsEnabled() ? 4 : base.practicalTaskCount;
  return { ...base, practicalTaskCount, timing: getTiming(certType, level) };
}

/**
 * Maximum number of attempts allowed within a single paid registration.
 * Each new Registration (one purchased schedule) starts a fresh counter, so
 * a candidate who exhausts their 3 attempts can re-purchase to reset the
 * bucket — see `CbtSessionsService.createFromRegistration`.
 *
 * Note: the legacy admin-only `CbtSessionsService.create()` path applies
 * this same cap globally per (userId, certType, level) since those sessions
 * are created without a registration link.
 */
export const MAX_ATTEMPTS = 3;

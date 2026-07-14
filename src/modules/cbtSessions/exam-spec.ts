import { CertLevel, CertType, ExamPart } from '@prisma/client';

/**
 * Exam standard version. Every rule that changed in 시험 표준 v2.0 (2026-07-05)
 * and v3.0 (new_version_v3 확정안, 2026-07-11) keys off the version STORED ON THE
 * SESSION (`ExamSession.specVersion`), never a global constant alone, so
 * in-flight sessions keep the rules they started under:
 *   - "1.1": pre-v2.0 rules (existing sessions default here).
 *   - "2.0": v2.0 rules — L3 70분(객관식 50 + 실습 20), 이중 최저기준 하드컷,
 *     명시적 경계밴드, human-locked 판정 상태.
 *   - "3.0": new_version_v3 확정안 — L3 90분/실습 8문항, L2 120분, L1 150분;
 *     총점 60 하드컷 + 40% 과락(L2 실습·L1 Part B는 60% 유지), L1 Part C 하드컷 신설.
 */
export type ExamSpecVersion = '1.1' | '2.0' | '3.0';

export const EXAM_SPEC_VERSIONS: readonly ExamSpecVersion[] = ['1.1', '2.0', '3.0'];

/**
 * Version stamped on NEW sessions. Default stays '2.0' during the v3.0 rollout;
 * `EXAM_SPEC_VERSION=3.0` opts an environment in (and `=1.1` remains the legacy
 * escape hatch).
 */
export function currentSpecVersion(): ExamSpecVersion {
  const raw = (process.env.EXAM_SPEC_VERSION || '2.0').trim();
  return (EXAM_SPEC_VERSIONS as readonly string[]).includes(raw) ? (raw as ExamSpecVersion) : '2.0';
}

/** Narrows a persisted `ExamSession.specVersion` string to a known version (unknown → "1.1"). */
export function toSpecVersion(raw: string | null | undefined): ExamSpecVersion {
  return raw === '3.0' ? '3.0' : raw === '2.0' ? '2.0' : '1.1';
}

/**
 * True for every spec version that uses the v2.0+ machinery (hard-cut gates,
 * human-locked decisions, PROVISIONAL staging, pretest embedding, difficulty
 * draw, embedded-AI policy by level). Use this — never `=== '2.0'` — at any
 * fork that means "v2 or later"; a missed site makes a '3.0' session silently
 * behave like v1.1 (auto-cert, AI unblocked, no staging).
 */
export function isV2OrLater(v: ExamSpecVersion): boolean {
  return v !== '1.1';
}

/** Raw column values for Prisma where-clauses (`specVersion: { in: V2_OR_LATER_VERSIONS }`). */
export const V2_OR_LATER_VERSIONS: readonly string[] = ['2.0', '3.0'];

/**
 * Certification series whose exams are SUSPENDED — no new sessions may start.
 *
 * Set via `SUSPENDED_SERIES` (comma-separated, e.g. "AXIS_C,AXIS_H"). Used when a
 * series' question bank has been withdrawn: without this guard a candidate would
 * hit the raw "Question bank empty" developer error at exam start. Existing
 * sessions, submitted papers and issued certificates are untouched — this only
 * blocks NEW sessions.
 */
export function suspendedSeries(): Set<string> {
  return new Set(
    (process.env.SUSPENDED_SERIES ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

export function isSeriesSuspended(certType: CertType): boolean {
  return suspendedSeries().has(certType);
}

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
 * minimum (과락/하드컷) as a percentage of that section's own max — null = no
 * floor. In v2.0 `gateKey` names the hard cut with the stable key used by the
 * session-aggregate schemas (AXIS_L*_채점_세션집계_JSON스키마_v1_0.json), e.g.
 * `objective_score_min_30`.
 */
export interface SectionScoring {
  part: ExamPart;
  weight: number;
  floorPct: number | null;
  gateKey?: string | null;
}

export interface LevelScoring {
  /** Overall pass score out of 100 (spec: 70 for L1/L2, and L3 since practicals). */
  passTotal: number;
  sections: SectionScoring[];
  /** v2.0: stable gate key for the total-score cut (`total_score_min_70`). */
  totalGateKey?: string | null;
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
 * the env var in tests/dev does not require a server restart. Defaults ON: L3
 * runs the new 운영기획서 shape — MCQ + 4 실습형:
 *   40 min written + 20 min practical = 60 min total,
 *   100 점 (객관식 60 + 실습형 40), pass 70, practical floor 60% (24/40).
 * Environments where the L3 practical pool has not been seeded fall back to
 * legacy MCQ-only automatically (session start finds 0 practical tasks), so
 * flipping the default ON is safe. Set the env var to 'false' to force legacy.
 * In-flight sessions are unaffected because their paper is already frozen at
 * `/cbt/sessions/:id/start`.
 */
function isL3PracticalsEnabled(): boolean {
  return (process.env.L3_PRACTICALS_ENABLED || 'true').toLowerCase() === 'true';
}

const L3_TIMING_WITH_PRACTICALS: LevelTiming = {
  // v1.1 운영기획서: 객관식 40문항 40분 + 실습형 4문항 20분 = 60분 총.
  totalMinutes: 60,
  writtenMinutes: 40,
  practicalMinutes: 20,
  passWritten: 60,
  passPractical: 60,
  subjectFailPct: 40,
};

const L3_TIMING_WITH_PRACTICALS_V2: LevelTiming = {
  // 시험 표준 v2.0 (메인 기획서 v2.0): 객관식 40문항 50분 + 실습형 4문항 20분
  // = 70분 총. 시나리오 지문(150~350자)이 문항당 72~90초를 요구해 객관식이
  // 40분 → 50분으로 늘었다. Legacy MCQ-only(L3_PRACTICALS_ENABLED=false)는
  // v2.0에서 deprecated지만 동작은 유지 — 60분 그대로.
  totalMinutes: 70,
  writtenMinutes: 50,
  practicalMinutes: 20,
  passWritten: 60,
  passPractical: 60,
  subjectFailPct: 40,
};

const L3_TIMING_WITH_PRACTICALS_V3: LevelTiming = {
  // 시험 표준 v3.0 (AXIS_L3_검정시간·합격선_확정안 2026-07-11): 총 90분 단일
  // 타이머 — 객관식 40문항 ~50분 + 실습형 8문항(유형별 2문항, 5분/문항) ~40분.
  // 파트 간 자유 이동, written/practical 분할은 권장 배분(집행은 총 시간만).
  totalMinutes: 90,
  writtenMinutes: 50,
  practicalMinutes: 40,
  passWritten: 60,
  passPractical: 60,
  subjectFailPct: 40,
};

/**
 * v3.0 base timing (확정안 2026-07-11). L1/L2 were unversioned before v3:
 *   L2: 120분 = 객관식 50 + 실습 70(과제 A25·B25·C20) — was 90 (30+60).
 *   L1: 150분 = Part A 40 + Part B 70 + Part C 40 — was 120 (30+90).
 * L3 flag-off(legacy MCQ-only)는 v3에서도 60분 그대로 (LEVEL_TIMING.L3).
 */
const LEVEL_TIMING_V3: Partial<Record<CertLevel, LevelTiming>> = {
  L2: { totalMinutes: 120, writtenMinutes: 50, practicalMinutes: 70, passWritten: 60, passPractical: 60, subjectFailPct: 40 },
  L1: { totalMinutes: 150, writtenMinutes: 40, practicalMinutes: 110, passWritten: 60, passPractical: 60, subjectFailPct: 40 },
};

export function getTiming(
  certType: CertType,
  level: CertLevel,
  specVersion: ExamSpecVersion,
): LevelTiming {
  let base = LEVEL_TIMING[level];
  if (specVersion === '3.0') {
    base = LEVEL_TIMING_V3[level] ?? base;
  }
  if (level === 'L3' && isL3PracticalsEnabled()) {
    base =
      specVersion === '3.0'
        ? L3_TIMING_WITH_PRACTICALS_V3
        : specVersion === '2.0'
          ? L3_TIMING_WITH_PRACTICALS_V2
          : L3_TIMING_WITH_PRACTICALS;
  }
  // CERT_TIMING_OVERRIDES predates v3 (AXIS_C L2 = 120분). The v3 L2 base is
  // already 120분, and a blind merge would yield 50+90 ≠ 120 — so the override
  // applies to ≤2.0 sessions only.
  const override = specVersion === '3.0' ? undefined : CERT_TIMING_OVERRIDES[certType]?.[level];
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

/** Stable gate keys shared with the v2.0 session-aggregate schemas. */
export const GATE_KEYS = {
  TOTAL: 'total_score_min_70',
  L3_OBJECTIVE: 'objective_score_min_30',
  L3_PRACTICE: 'practice_score_min_24',
  L2_OBJECTIVE: 'objective_score_min_15',
  L2_PRACTICE: 'practice_score_min_42',
  L1_PART_A: 'part_a_min_13',
  L1_PART_B: 'part_b_min_33',
} as const;

/**
 * v3.0 gate keys — verbatim from the new_version_v3 세션집계 JSON schemas
 * (`gate_results.required`). The names encode the v3 cut values (총점 60,
 * 40% 과락 신설, L1 Part C 하드컷 신설).
 */
export const GATE_KEYS_V3 = {
  TOTAL: 'total_score_min_60',
  L3_OBJECTIVE: 'objective_score_min_24',
  L3_PRACTICE: 'practice_score_min_16',
  L2_OBJECTIVE: 'objective_score_min_12',
  L2_PRACTICE: 'practice_score_min_42',
  L1_PART_A: 'part_a_min_10',
  L1_PART_B: 'part_b_min_33',
  L1_PART_C: 'part_c_min_8',
} as const;

/**
 * 시험 표준 v2.0 하드컷 (각 기획서 v2.0, ALL must pass):
 *   L3: 총점 ≥70 + 객관식 ≥30/60 (50% — v2.0 신설) + 실습형 ≥24/40 (60%).
 *   L2: 총점 ≥70 + 객관식 ≥15/30 (50%) + 실습형 ≥42/70 (60%) — v1.1과 동일.
 *   L1: 총점 ≥70 + Part A ≥13/25 (52% — v2.0 신설) + Part B ≥33/55 (60%).
 *       Part C(서술형)는 하드컷 없음 — v1.1의 60% 플로어(12/20)는 제거되고
 *       "Part C 검수 기준(12 미만)"은 검수 트리거로만 남는다 (review-bands.ts). Part C
 *       불합격 통제는 치명 실패 패턴이 담당한다 (L1 세션집계 스키마:
 *       "Part C는 하드컷 없음 — 치명 실패로 통제").
 * floorPct는 각 섹션 자체 만점 대비 % (weight == 섹션 만점이므로 13/25 = 52%).
 */
const LEVEL_SCORING_V2: Record<CertLevel, LevelScoring> = {
  L3: {
    passTotal: 70,
    totalGateKey: GATE_KEYS.TOTAL,
    sections: [
      { part: ExamPart.WRITTEN, weight: 60, floorPct: 50, gateKey: GATE_KEYS.L3_OBJECTIVE },
      { part: ExamPart.PRACTICAL, weight: 40, floorPct: 60, gateKey: GATE_KEYS.L3_PRACTICE },
    ],
  },
  L2: {
    passTotal: 70,
    totalGateKey: GATE_KEYS.TOTAL,
    sections: [
      { part: ExamPart.WRITTEN, weight: 30, floorPct: 50, gateKey: GATE_KEYS.L2_OBJECTIVE },
      { part: ExamPart.PRACTICAL, weight: 70, floorPct: 60, gateKey: GATE_KEYS.L2_PRACTICE },
    ],
  },
  L1: {
    passTotal: 70,
    totalGateKey: GATE_KEYS.TOTAL,
    sections: [
      { part: ExamPart.WRITTEN, weight: 25, floorPct: 52, gateKey: GATE_KEYS.L1_PART_A },
      { part: ExamPart.DELIVERABLE, weight: 55, floorPct: 60, gateKey: GATE_KEYS.L1_PART_B },
      { part: ExamPart.ESSAY, weight: 20, floorPct: null, gateKey: null },
    ],
  },
};

/**
 * 시험 표준 v3.0 하드컷 (new_version_v3 확정안 2026-07-11, ALL must pass):
 *   L3: 총점 ≥60 + 객관식 ≥24/60 (40%) + 실습형 ≥16/40 (40%).
 *   L2: 총점 ≥60 + 객관식 ≥12/30 (40%) + 실습형 ≥42/70 (60% — 불변 하드컷).
 *   L1: 총점 ≥60 + Part A ≥10/25 (40%) + Part B ≥33/55 (60%)
 *       + Part C ≥8/20 (40% — v3.0 신설 하드컷; v2.0에서는 검수 트리거만 있었음).
 */
const LEVEL_SCORING_V3: Record<CertLevel, LevelScoring> = {
  L3: {
    passTotal: 60,
    totalGateKey: GATE_KEYS_V3.TOTAL,
    sections: [
      { part: ExamPart.WRITTEN, weight: 60, floorPct: 40, gateKey: GATE_KEYS_V3.L3_OBJECTIVE },
      { part: ExamPart.PRACTICAL, weight: 40, floorPct: 40, gateKey: GATE_KEYS_V3.L3_PRACTICE },
    ],
  },
  L2: {
    passTotal: 60,
    totalGateKey: GATE_KEYS_V3.TOTAL,
    sections: [
      { part: ExamPart.WRITTEN, weight: 30, floorPct: 40, gateKey: GATE_KEYS_V3.L2_OBJECTIVE },
      { part: ExamPart.PRACTICAL, weight: 70, floorPct: 60, gateKey: GATE_KEYS_V3.L2_PRACTICE },
    ],
  },
  L1: {
    passTotal: 60,
    totalGateKey: GATE_KEYS_V3.TOTAL,
    sections: [
      { part: ExamPart.WRITTEN, weight: 25, floorPct: 40, gateKey: GATE_KEYS_V3.L1_PART_A },
      { part: ExamPart.DELIVERABLE, weight: 55, floorPct: 60, gateKey: GATE_KEYS_V3.L1_PART_B },
      { part: ExamPart.ESSAY, weight: 20, floorPct: 40, gateKey: GATE_KEYS_V3.L1_PART_C },
    ],
  },
};

// Scoring is currently uniform across series; the certType param keeps call
// sites future-proof for a per-series override (mirrors getTiming).
export function getScoring(
  _certType: CertType,
  level: CertLevel,
  specVersion: ExamSpecVersion,
): LevelScoring {
  if (specVersion === '3.0') {
    // Legacy MCQ-only L3 keeps the v1.1 written-only model on any version.
    if (level === 'L3' && !isL3PracticalsEnabled()) return LEVEL_SCORING.L3;
    return LEVEL_SCORING_V3[level];
  }
  if (specVersion === '2.0') {
    // Legacy MCQ-only L3 (deprecated flag-off mode) has no v2.0 definition —
    // it keeps the v1.1 written-only model even on v2.0 sessions.
    if (level === 'L3' && !isL3PracticalsEnabled()) return LEVEL_SCORING.L3;
    return LEVEL_SCORING_V2[level];
  }
  if (level === 'L3' && isL3PracticalsEnabled()) {
    return L3_SCORING_WITH_PRACTICALS;
  }
  return LEVEL_SCORING[level];
}

/**
 * Section floor (%) for one exam part at (certType, level) — null when the
 * section has no floor or the part isn't in the level's scoring model. Used by
 * the AI-prescore review triggers (a task near/below its section floor is
 * routed to mandatory expert review).
 */
export function getSectionFloorPct(
  certType: CertType,
  level: CertLevel,
  part: ExamPart,
  specVersion: ExamSpecVersion,
): number | null {
  const section = getScoring(certType, level, specVersion).sections.find((s) => s.part === part);
  return section?.floorPct ?? null;
}

export interface WeightedResult {
  /** 0–100 weighted total, rounded. */
  total: number;
  /** True iff total ≥ passTotal AND every section clears its floor. */
  passed: boolean;
  /** Sections that fell below their floor (과락/하드컷). */
  floorFailures: ExamPart[];
  /**
   * Hard-cut outcomes keyed by the session-aggregate schema gate keys
   * (`true` = gate cleared). Empty for scoring models without gate keys
   * (v1.1) — those callers keep reading `floorFailures`.
   */
  gateResults: Record<string, boolean>;
  /** Gate keys that failed, in section order (total gate last). */
  failedGates: string[];
}

/**
 * Pure weighted-100 scorer shared by the finalize path and the smoke test.
 * `sectionPct(part)` returns that section's score as a percentage of its own
 * max (0–100). Pass requires the weighted total to clear `passTotal` AND every
 * section with a floor to clear it. Because each section's `weight` equals its
 * max points in the 100-point model, the pct floors are exactly the v2.0
 * point cuts (e.g. 객관식 30/60 ⇔ WRITTEN pct ≥ 50).
 */
export function computeWeightedResult(
  scoring: LevelScoring,
  sectionPct: (part: ExamPart) => number,
): WeightedResult {
  let weightedTotal = 0;
  const floorFailures: ExamPart[] = [];
  const gateResults: Record<string, boolean> = {};
  const failedGates: string[] = [];
  for (const sec of scoring.sections) {
    const pct = sectionPct(sec.part);
    weightedTotal += (pct / 100) * sec.weight;
    const cleared = sec.floorPct == null || pct >= sec.floorPct;
    if (!cleared) floorFailures.push(sec.part);
    if (sec.gateKey) {
      gateResults[sec.gateKey] = cleared;
      if (!cleared) failedGates.push(sec.gateKey);
    }
  }
  const total = Math.round(weightedTotal);
  const totalCleared = total >= scoring.passTotal;
  if (scoring.totalGateKey) {
    gateResults[scoring.totalGateKey] = totalCleared;
    if (!totalCleared) failedGates.push(scoring.totalGateKey);
  }
  return {
    total,
    passed: totalCleared && floorFailures.length === 0,
    floorFailures,
    gateResults,
    failedGates,
  };
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

export function getExamSpec(
  certType: CertType,
  level: CertLevel,
  specVersion: ExamSpecVersion,
): LevelExamSpec {
  const base = LEVEL_EXAM_SPEC[level];
  // L3 flag flip: 실습형 on top of the 40 MCQ — v3.0 draws 8 (층화 2/유형),
  // v2.0/v1.1 draw 4 (층화 1/유형).
  const practicalTaskCount =
    level === 'L3' && isL3PracticalsEnabled() ? (specVersion === '3.0' ? 8 : 4) : base.practicalTaskCount;
  return { ...base, practicalTaskCount, timing: getTiming(certType, level, specVersion) };
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

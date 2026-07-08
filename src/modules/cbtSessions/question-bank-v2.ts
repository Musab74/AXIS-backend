/**
 * 시험 표준 v2.0 question-bank & authoring infrastructure (WP10).
 *
 * Pure config + helpers — the data-model side of item lifecycle, pretest
 * embedding, stratified-generation blueprints, anchor items and bank-size
 * targets. Content production is out of scope; generation falls back to the
 * legacy subject-distribution draw (with logged warnings) until banks carry
 * the v2.0 tags.
 */
import { CertLevel } from '@prisma/client';

/** Item lifecycle states — exact Korean strings from the v2.0 기획서. */
export const ITEM_LIFECYCLE = {
  DRAFT: '초안',
  REVIEW_1: '1차검수',
  REVIEW_2: '2차검수',
  PRETEST: '사전검증',
  APPROVED: '승인',
  INACTIVE: '비활성',
  RETIRED: '폐기',
} as const;

export type ItemLifecycleStatus = (typeof ITEM_LIFECYCLE)[keyof typeof ITEM_LIFECYCLE];

export const ITEM_LIFECYCLE_ORDER: readonly ItemLifecycleStatus[] = [
  ITEM_LIFECYCLE.DRAFT,
  ITEM_LIFECYCLE.REVIEW_1,
  ITEM_LIFECYCLE.REVIEW_2,
  ITEM_LIFECYCLE.PRETEST,
  ITEM_LIFECYCLE.APPROVED,
  ITEM_LIFECYCLE.INACTIVE,
  ITEM_LIFECYCLE.RETIRED,
];

/**
 * Only 승인 items are drawable as SCORED items. Legacy rows (NULL lifecycle)
 * predate v2.0 and remain drawable through the `active` flag alone — flipping
 * them off would empty every existing bank.
 */
export function isDrawableScored(lifecycleStatus: string | null | undefined): boolean {
  return lifecycleStatus == null || lifecycleStatus === ITEM_LIFECYCLE.APPROVED;
}

/** 사전검증 items may embed as unscored pretest slots only. */
export function isDrawablePretest(lifecycleStatus: string | null | undefined): boolean {
  return lifecycleStatus === ITEM_LIFECYCLE.PRETEST;
}

/**
 * Canonical difficulty labels. L3/L2 use 하/중/상; L1 uses 중/상/최상 (no easy
 * tier — leadership judgment, L1 기획서 4-3: 중 50% / 상 40% / 최상 10%). The
 * bank stores tags in either Korean or the legacy English (easy/medium/hard);
 * `normalizeDifficulty` folds both onto these.
 */
export const DIFFICULTY = { LOW: '하', MID: '중', HIGH: '상', TOP: '최상' } as const;
export type CanonDifficulty = (typeof DIFFICULTY)[keyof typeof DIFFICULTY];

const DIFFICULTY_ALIASES: Record<string, CanonDifficulty> = {
  하: '하', 중: '중', 상: '상', 최상: '최상',
  easy: '하', lower: '하', low: '하',
  medium: '중', mid: '중', normal: '중',
  hard: '상', upper: '상', high: '상',
  highest: '최상', top: '최상', expert: '최상',
};

/** Fold a raw difficulty tag (Korean or English) onto a canonical label, or null. */
export function normalizeDifficulty(raw: string | null | undefined): CanonDifficulty | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return null;
  return DIFFICULTY_ALIASES[v] ?? DIFFICULTY_ALIASES[(raw ?? '').trim()] ?? null;
}

/**
 * L3 실습형 fixed difficulty by canonical practice type (v2.0 기획서: 매 시험
 * 중2 + 상2). The 4-item paper draws exactly one per type, so pinning each
 * type's difficulty here enforces the 중·중·상·상 rule at draw time.
 */
export const PRACTICAL_DIFFICULTY_BY_TYPE: Record<string, CanonDifficulty> = {
  현업적용형: '중',
  지시설계형: '중',
  분석검증형: '상',
  리스크판단형: '상',
};

/** 기술 전제 유형 enum (v2.1 template). ≠ '없음' shortens the review cycle. */
export const TECH_ASSUMPTION_TYPES = [
  '없음',
  '최신성한계',
  '메모리·컨텍스트',
  '파일·데이터처리',
  '계산정확성',
  '기타',
] as const;

/** Review cycle: 12 months standard, 6 months when a tech assumption exists. */
export function reviewCycleMonths(techAssumptionType: string | null | undefined): number {
  return !techAssumptionType || techAssumptionType === '없음' ? 12 : 6;
}

export interface PretestAcceptanceRule {
  minResponses: number;
  /** 정답률 목표 밴드 by difficulty (하/중/상). */
  correctRateBands: Record<string, { min: number; max: number }>;
  minDiscrimination: number; // ≥ 0.20 promote; 0.10–0.19 revise; < 0.10 discard
  reviseDiscrimination: number;
  minDistractorRate: number; // every distractor ≥ 5%
}

export interface LevelBankBlueprint {
  /** Max unscored 사전검증 items embedded per form (≤10%). */
  maxPretestPerForm: number;
  /** 난이도 분포 per form (하/중/상 counts). */
  difficultyDistribution: Record<string, number>;
  /** 문항유형 분포 per form (exact tag → count). */
  typeDistribution: Record<string, number>;
  /** Ops bank-size floor — log a warning when the drawable pool is below. */
  minBankSize: number;
  /** Anchor items: share of forms carrying them (10–15%). */
  anchorShare: { min: number; max: number };
  pretest: PretestAcceptanceRule;
}

const COMMON_PRETEST: Omit<PretestAcceptanceRule, 'correctRateBands'> = {
  minResponses: 100,
  minDiscrimination: 0.2,
  reviseDiscrimination: 0.1,
  minDistractorRate: 0.05,
};
const COMMON_BANDS = {
  하: { min: 0.7, max: 0.9 },
  중: { min: 0.45, max: 0.75 },
  상: { min: 0.25, max: 0.55 },
};

/**
 * Per-level stratified-generation blueprints (각 기획서 v2.0). Difficulty and
 * type counts are per generated form; provisional — tune here only.
 * (L1's 기획서 also describes a 중/상/최상 difficulty axis; the 하/중/상
 * counts below follow the migration directive.)
 */
export const BANK_BLUEPRINTS_V2: Record<CertLevel, LevelBankBlueprint> = {
  L3: {
    maxPretestPerForm: 4,
    difficultyDistribution: { 하: 8, 중: 22, 상: 10 },
    typeDistribution: {
      현업적용형: 12,
      '분석·검증형': 10,
      '리스크 판단형': 8,
      지시설계형: 6,
      '개념·한계 판단형': 4,
    },
    minBankSize: 400,
    anchorShare: { min: 0.1, max: 0.15 },
    pretest: { ...COMMON_PRETEST, correctRateBands: COMMON_BANDS },
  },
  L2: {
    maxPretestPerForm: 3,
    difficultyDistribution: { 하: 4, 중: 17, 상: 9 },
    typeDistribution: {
      현업문제정의형: 6,
      '고급 지시설계형': 6,
      '산출물 검증형': 7,
      '리스크 통제형': 6,
      '업무흐름 설계형': 5,
    },
    minBankSize: 300,
    anchorShare: { min: 0.1, max: 0.15 },
    pretest: { ...COMMON_PRETEST, correctRateBands: COMMON_BANDS },
  },
  L1: {
    maxPretestPerForm: 2,
    // L1 기획서 4-3: 중 50% / 상 40% / 최상 10% of 25 (no 하 tier — leadership
    // judgment). NOT 하/중/상 like L2·L3.
    difficultyDistribution: { 중: 13, 상: 10, 최상: 2 },
    typeDistribution: {
      조직진단형: 4,
      과제포트폴리오형: 4,
      '거버넌스 설계형': 4,
      '리스크·컴플라이언스형': 5,
      품질관리형: 3,
      변화관리형: 3,
      '성과관리형·사고대응형': 2,
    },
    minBankSize: 250,
    anchorShare: { min: 0.1, max: 0.15 },
    pretest: { ...COMMON_PRETEST, correctRateBands: COMMON_BANDS },
  },
};

/** L3 practical pool floor: ≥ 10 items per practice type (ops warning). */
export const L3_PRACTICAL_MIN_PER_TYPE = 10;

export interface AnswerPositionAudit {
  ok: boolean;
  /** Position counts per answer key (A–D). */
  counts: Record<string, number>;
  problems: string[];
}

/**
 * 정답위치 감사 (v2.0): A–D roughly even per form (9~11 per 40 → scaled band
 * ±[form/16] around form/4), max 3 consecutive same key, no short periodic
 * pattern (period 2–4 repeating across the whole form).
 */
export function auditAnswerPositions(keys: string[]): AnswerPositionAudit {
  const counts: Record<string, number> = {};
  for (const k of keys) counts[k] = (counts[k] ?? 0) + 1;
  const problems: string[] = [];
  const n = keys.length;
  if (n >= 8) {
    const expected = n / 4;
    const slack = Math.max(1, Math.round(n / 16)); // 40문항 → ±2.5 ≈ 9~11 band
    for (const key of ['A', 'B', 'C', 'D']) {
      const c = counts[key] ?? 0;
      if (c < Math.floor(expected - slack) || c > Math.ceil(expected + slack)) {
        problems.push(`정답위치 ${key} 분포 이탈 (${c}/${n}, 기대 ${Math.round(expected)}±${slack})`);
      }
    }
  }
  let run = 1;
  for (let i = 1; i < n; i++) {
    run = keys[i] === keys[i - 1] ? run + 1 : 1;
    if (run === 4) {
      problems.push(`동일 정답 4연속 (index ${i - 3}~${i}, key ${keys[i]})`);
      break;
    }
  }
  // Periodic pattern: the whole form repeating with period 2–4 (e.g. ABABAB…).
  for (let period = 2; period <= 4 && n >= period * 3; period++) {
    let periodic = true;
    for (let i = period; i < n; i++) {
      if (keys[i] !== keys[i - period]) {
        periodic = false;
        break;
      }
    }
    if (periodic) {
      problems.push(`주기 ${period} 정답 패턴 감지`);
      break;
    }
  }
  return { ok: problems.length === 0, counts, problems };
}

export interface DifficultyDrawResult<T> {
  selected: T[];
  /** Bands the bank could not fully supply (need > available). */
  shortfalls: { difficulty: string; need: number; got: number }[];
  /** Items drawn from outside the target bands to reach the form length. */
  backfilled: number;
  /** Final per-band counts of the selected form (canonical labels). */
  bandCounts: Record<string, number>;
}

/**
 * 층화 랜덤출제 (v2.0 기획서 8-3): draw a form that matches the level's
 * `difficultyDistribution`, spreading each band across subjects so no single
 * subject dominates a band. Deterministic (seeded shuffle). Degrades safely —
 * a band the bank can't fill records a shortfall and is backfilled from the
 * remaining pool so the form is still full length (never blocks the exam while
 * banks are being populated). Difficulty is the enforced axis; subject is a
 * best-effort spread within each band.
 */
export function stratifiedDrawByDifficulty<T>(
  pool: readonly T[],
  distribution: Record<string, number>,
  difficultyOf: (t: T) => string | null | undefined,
  subjectOf: (t: T) => number,
  shuffle: (items: readonly T[], salt: string) => T[],
  seedSalt: string,
): DifficultyDrawResult<T> {
  const byBand = new Map<string, T[]>();
  for (const it of pool) {
    const band = normalizeDifficulty(difficultyOf(it));
    if (!band) continue;
    (byBand.get(band) ?? byBand.set(band, []).get(band)!).push(it);
  }

  const roundRobinBySubject = (items: readonly T[], need: number, salt: string): T[] => {
    const bySub = new Map<number, T[]>();
    for (const it of shuffle(items, salt)) {
      const s = subjectOf(it);
      (bySub.get(s) ?? bySub.set(s, []).get(s)!).push(it);
    }
    const queues = [...bySub.values()];
    const out: T[] = [];
    for (let i = 0; out.length < need && queues.some((q) => q.length); i++) {
      const q = queues[i % queues.length];
      if (q.length) out.push(q.shift()!);
    }
    return out;
  };

  const selected: T[] = [];
  const used = new Set<T>();
  const shortfalls: DifficultyDrawResult<T>['shortfalls'] = [];
  const bandCounts: Record<string, number> = {};

  for (const [rawBand, need] of Object.entries(distribution)) {
    const band = normalizeDifficulty(rawBand) ?? rawBand;
    const take = roundRobinBySubject(byBand.get(band) ?? [], need, `${seedSalt}:${band}`);
    for (const it of take) {
      selected.push(it);
      used.add(it);
    }
    bandCounts[band] = take.length;
    if (take.length < need) shortfalls.push({ difficulty: band, need, got: take.length });
  }

  const target = Object.values(distribution).reduce((s, n) => s + n, 0);
  let backfilled = 0;
  if (selected.length < target) {
    const remaining = shuffle(pool.filter((p) => !used.has(p)), `${seedSalt}:backfill`);
    for (const it of remaining) {
      if (selected.length >= target) break;
      selected.push(it);
      backfilled++;
      const band = normalizeDifficulty(difficultyOf(it));
      if (band) bandCounts[band] = (bandCounts[band] ?? 0) + 1;
    }
  }

  return { selected, shortfalls, backfilled, bandCounts };
}

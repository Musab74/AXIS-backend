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
    difficultyDistribution: { 하: 3, 중: 14, 상: 8 },
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

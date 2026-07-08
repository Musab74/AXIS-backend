import {
  normalizeDifficulty,
  stratifiedDrawByDifficulty,
  BANK_BLUEPRINTS_V2,
  PRACTICAL_DIFFICULTY_BY_TYPE,
} from './question-bank-v2';

/** Deterministic seeded shuffle (unsigned 32-bit, mirrors shuffleWithSeed's contract). */
function seededShuffle<T>(items: readonly T[], salt: string): T[] {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < salt.length; i++) h = Math.imul(h ^ salt.charCodeAt(i), 16777619) >>> 0;
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    h = Math.imul(h, 48271) >>> 0;
    const j = h % (i + 1); // h unsigned → j always in [0, i]
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

interface Q {
  id: string;
  difficulty: string;
  subjectIndex: number;
}
function bank(counts: Record<string, number>, subjects = 4): Q[] {
  const out: Q[] = [];
  let n = 0;
  for (const [diff, c] of Object.entries(counts)) {
    for (let i = 0; i < c; i++) out.push({ id: `${diff}-${i}`, difficulty: diff, subjectIndex: n++ % subjects });
  }
  return out;
}
const draw = (pool: Q[], dist: Record<string, number>, salt = 's') =>
  stratifiedDrawByDifficulty(pool, dist, (q) => q.difficulty, (q) => q.subjectIndex, seededShuffle, salt);
const countBy = (rows: Q[]) =>
  rows.reduce<Record<string, number>>((m, r) => ((m[normalizeDifficulty(r.difficulty)!] = (m[normalizeDifficulty(r.difficulty)!] ?? 0) + 1), m), {});

describe('normalizeDifficulty', () => {
  it('folds Korean and English onto canonical labels', () => {
    expect(normalizeDifficulty('easy')).toBe('하');
    expect(normalizeDifficulty('medium')).toBe('중');
    expect(normalizeDifficulty('hard')).toBe('상');
    expect(normalizeDifficulty('최상')).toBe('최상');
    expect(normalizeDifficulty('중')).toBe('중');
    expect(normalizeDifficulty('HARD')).toBe('상');
    expect(normalizeDifficulty('')).toBeNull();
    expect(normalizeDifficulty(null)).toBeNull();
    expect(normalizeDifficulty('???')).toBeNull();
  });
});

describe('stratifiedDrawByDifficulty', () => {
  it('hits the L3 target (8하/22중/10상) exactly from a rich bank', () => {
    const pool = bank({ 하: 100, 중: 200, 상: 100 });
    const r = draw(pool, BANK_BLUEPRINTS_V2.L3.difficultyDistribution);
    expect(r.selected).toHaveLength(40);
    expect(countBy(r.selected)).toEqual({ 하: 8, 중: 22, 상: 10 });
    expect(r.shortfalls).toHaveLength(0);
    expect(r.backfilled).toBe(0);
  });

  it('hits the L1 target (13중/10상/2최상) — the no-easy leadership scale', () => {
    const pool = bank({ 중: 60, 상: 60, 최상: 20 });
    const r = draw(pool, BANK_BLUEPRINTS_V2.L1.difficultyDistribution);
    expect(r.selected).toHaveLength(25);
    expect(countBy(r.selected)).toEqual({ 중: 13, 상: 10, 최상: 2 });
  });

  it('accepts an English-tagged bank via normalization', () => {
    const pool = bank({ easy: 50, medium: 50, hard: 50 });
    const r = draw(pool, { 하: 8, 중: 22, 상: 10 });
    expect(countBy(r.selected)).toEqual({ 하: 8, 중: 22, 상: 10 });
  });

  it('records a shortfall and backfills to full length when a band is thin', () => {
    // Only 3 최상 available but 최상 target needs more; here L1 needs 2 최상 → fine,
    // but make 상 thin to force a shortfall.
    const pool = bank({ 중: 60, 상: 4, 최상: 20 });
    const r = draw(pool, { 중: 13, 상: 10, 최상: 2 });
    expect(r.selected).toHaveLength(25); // still full length
    expect(r.shortfalls).toEqual([{ difficulty: '상', need: 10, got: 4 }]);
    expect(r.backfilled).toBe(6); // 10−4 backfilled from other bands
  });

  it('spreads a band across subjects rather than taking all from one', () => {
    // 22 중 items across 4 subjects → each subject should contribute ~5-6, not 22 from one.
    const pool = bank({ 하: 20, 중: 40, 상: 20 }, 4);
    const r = draw(pool, { 하: 8, 중: 22, 상: 10 });
    const mids = r.selected.filter((q) => normalizeDifficulty(q.difficulty) === '중');
    const perSubject = mids.reduce<Record<number, number>>((m, q) => ((m[q.subjectIndex] = (m[q.subjectIndex] ?? 0) + 1), m), {});
    for (const c of Object.values(perSubject)) expect(c).toBeLessThanOrEqual(8); // no subject monopolises
    expect(Object.keys(perSubject).length).toBeGreaterThanOrEqual(3); // spread across ≥3 subjects
  });

  it('is deterministic for the same seed and varies with the seed', () => {
    const pool = bank({ 하: 30, 중: 40, 상: 30 });
    const a = draw(pool, { 하: 8, 중: 22, 상: 10 }, 'seedA').selected.map((q) => q.id);
    const b = draw(pool, { 하: 8, 중: 22, 상: 10 }, 'seedA').selected.map((q) => q.id);
    const c = draw(pool, { 하: 8, 중: 22, 상: 10 }, 'seedB').selected.map((q) => q.id);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});

describe('PRACTICAL_DIFFICULTY_BY_TYPE (중·중·상·상)', () => {
  it('pins the 4 canonical L3 practice types to 2 medium + 2 hard', () => {
    expect(PRACTICAL_DIFFICULTY_BY_TYPE['현업적용형']).toBe('중');
    expect(PRACTICAL_DIFFICULTY_BY_TYPE['지시설계형']).toBe('중');
    expect(PRACTICAL_DIFFICULTY_BY_TYPE['분석검증형']).toBe('상');
    expect(PRACTICAL_DIFFICULTY_BY_TYPE['리스크판단형']).toBe('상');
    const bands = Object.values(PRACTICAL_DIFFICULTY_BY_TYPE);
    expect(bands.filter((b) => b === '중')).toHaveLength(2);
    expect(bands.filter((b) => b === '상')).toHaveLength(2);
  });
});

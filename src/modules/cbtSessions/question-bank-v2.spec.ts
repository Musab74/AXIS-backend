/**
 * v2.0 question-bank infrastructure (WP10): lifecycle drawability, pretest
 * scoring exclusion, and the answer-position audit.
 */
import {
  auditAnswerPositions,
  BANK_BLUEPRINTS_V2,
  isDrawablePretest,
  isDrawableScored,
  ITEM_LIFECYCLE,
  reviewCycleMonths,
} from './question-bank-v2';
import { computeWrittenScoring } from '../grading/written-scoring';

describe('item lifecycle drawability', () => {
  it('only 승인 (or legacy NULL) rows are drawable as scored items', () => {
    expect(isDrawableScored(ITEM_LIFECYCLE.APPROVED)).toBe(true);
    expect(isDrawableScored(null)).toBe(true); // legacy banks unchanged
    for (const s of ['초안', '1차검수', '2차검수', '사전검증', '비활성', '폐기']) {
      expect(isDrawableScored(s)).toBe(false);
    }
  });

  it('only 사전검증 rows are drawable as pretest slots', () => {
    expect(isDrawablePretest(ITEM_LIFECYCLE.PRETEST)).toBe(true);
    expect(isDrawablePretest(ITEM_LIFECYCLE.APPROVED)).toBe(false);
    expect(isDrawablePretest(null)).toBe(false);
  });

  it('tech-assumption review cycle: 12 months standard, 6 with an assumption', () => {
    expect(reviewCycleMonths('없음')).toBe(12);
    expect(reviewCycleMonths(null)).toBe(12);
    expect(reviewCycleMonths('최신성한계')).toBe(6);
    expect(reviewCycleMonths('계산정확성')).toBe(6);
  });

  it('blueprint counts sum to each level form size; pretest caps ≤10%', () => {
    const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
    expect(sum(BANK_BLUEPRINTS_V2.L3.difficultyDistribution)).toBe(40);
    expect(sum(BANK_BLUEPRINTS_V2.L3.typeDistribution)).toBe(40);
    expect(sum(BANK_BLUEPRINTS_V2.L2.difficultyDistribution)).toBe(30);
    expect(sum(BANK_BLUEPRINTS_V2.L2.typeDistribution)).toBe(30);
    expect(sum(BANK_BLUEPRINTS_V2.L1.difficultyDistribution)).toBe(25);
    expect(sum(BANK_BLUEPRINTS_V2.L1.typeDistribution)).toBe(25);
    expect(BANK_BLUEPRINTS_V2.L3.maxPretestPerForm).toBe(4);
    expect(BANK_BLUEPRINTS_V2.L2.maxPretestPerForm).toBe(3);
    expect(BANK_BLUEPRINTS_V2.L1.maxPretestPerForm).toBe(2);
  });
});

describe('answer-position audit', () => {
  const seq = (s: string) => s.split('');

  it('accepts a balanced, non-repeating form', () => {
    const keys = seq('ABCDDCBAABCDBADC'.repeat(1)); // 16 keys, 4 each
    const audit = auditAnswerPositions(keys);
    expect(audit.ok).toBe(true);
  });

  it('flags 4+ consecutive identical keys', () => {
    const audit = auditAnswerPositions(seq('AAAABCDABCDABCDA'));
    expect(audit.ok).toBe(false);
    expect(audit.problems.join(' ')).toContain('4연속');
  });

  it('flags a skewed key distribution', () => {
    const audit = auditAnswerPositions(seq('AABAACAADAABAACA')); // A-heavy
    expect(audit.ok).toBe(false);
    expect(audit.problems.some((p) => p.includes('분포 이탈'))).toBe(true);
  });

  it('flags a periodic pattern', () => {
    const audit = auditAnswerPositions(seq('ABABABABABAB'));
    expect(audit.problems.some((p) => p.includes('주기'))).toBe(true);
  });
});

describe('pretest slots are excluded from written score math', () => {
  it('records correctness for stats but contributes 0 to totals', () => {
    const bank = new Map([
      ['q1', { id: 'q1', correctAnswer: 'A', subjectIndex: 0, subjectName: 'S', points: 2 }],
      ['q2', { id: 'q2', correctAnswer: 'B', subjectIndex: 0, subjectName: 'S', points: 2 }],
      ['qp', { id: 'qp', correctAnswer: 'C', subjectIndex: 0, subjectName: 'S', points: 2 }],
    ]);
    const out = computeWrittenScoring(
      [
        { id: 'a1', questionId: 'q1', selectedChoice: 'A', contentSnapshot: null },
        { id: 'a2', questionId: 'q2', selectedChoice: 'A', contentSnapshot: null },
        // Correctly answered PRETEST item: stats yes, points no.
        { id: 'ap', questionId: 'qp', selectedChoice: 'C', contentSnapshot: null, isPretest: true },
      ],
      bank,
    );
    expect(out.writtenTotal).toBe(4); // pretest item excluded from denominator
    expect(out.writtenEarned).toBe(2);
    expect(out.writtenPct).toBe(50); // NOT inflated by the pretest hit
    const pretest = out.perAnswer.find((p) => p.answerId === 'ap');
    expect(pretest).toEqual({ answerId: 'ap', correct: true, earned: 0 });
    expect(out.subjectAgg.get(0)?.total).toBe(4);
  });
});

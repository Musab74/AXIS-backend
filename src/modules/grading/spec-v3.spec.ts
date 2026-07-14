import { CertLevel, CertType, ExamPart } from '@prisma/client';
import {
  computeWeightedResult,
  getExamSpec,
  getScoring,
  getTiming,
  isV2OrLater,
  toSpecVersion,
} from '../cbtSessions/exam-spec';
import { REVIEW_BANDS_V3, REVIEW_REASONS_V3, sessionReviewV2 } from './review-bands';
import {
  SESSION_AGGREGATE_SCHEMAS_BY_SPEC,
  SESSION_AGGREGATE_SCHEMA_VERSIONS,
} from './session-aggregate-schemas';

/**
 * 시험 표준 v3.0 (new_version_v3 확정안 2026-07-11) pins. The v2.0 assertions in
 * the other specs stay as regression guards — this file asserts the NEW rules
 * and, critically, that '3.0' never degrades to the v1.1 code paths.
 */
describe('spec v3.0 — version plumbing', () => {
  it('narrows a persisted "3.0" instead of falling back to v1.1', () => {
    expect(toSpecVersion('3.0')).toBe('3.0');
    expect(toSpecVersion('2.0')).toBe('2.0');
    expect(toSpecVersion('9.9')).toBe('1.1');
  });

  it('treats 3.0 as v2-or-later everywhere (gates, staging, AI policy, certs)', () => {
    expect(isV2OrLater('3.0')).toBe(true);
    expect(isV2OrLater('2.0')).toBe(true);
    expect(isV2OrLater('1.1')).toBe(false);
  });
});

describe('spec v3.0 — timing', () => {
  it('L3 = 90분 (객관식 50 + 실습 40)', () => {
    const t = getTiming(CertType.AXIS, CertLevel.L3, '3.0');
    expect(t.totalMinutes).toBe(90);
    expect(t.writtenMinutes).toBe(50);
    expect(t.practicalMinutes).toBe(40);
  });

  it('L2 = 120분, L1 = 150분', () => {
    expect(getTiming(CertType.AXIS, CertLevel.L2, '3.0').totalMinutes).toBe(120);
    expect(getTiming(CertType.AXIS, CertLevel.L1, '3.0').totalMinutes).toBe(150);
  });

  it('AXIS_C L2 override does not corrupt the v3 base (stays 120)', () => {
    // The ≤2.0 override (120/practical 90) must not merge into the v3 base,
    // which would yield 50 + 90 ≠ 120.
    expect(getTiming(CertType.AXIS_C, CertLevel.L2, '3.0').totalMinutes).toBe(120);
    expect(getTiming(CertType.AXIS_C, CertLevel.L2, '2.0').totalMinutes).toBe(120); // v2 unchanged
  });

  it('v2.0 timings are untouched (regression)', () => {
    expect(getTiming(CertType.AXIS, CertLevel.L3, '2.0').totalMinutes).toBe(70);
    expect(getTiming(CertType.AXIS, CertLevel.L2, '2.0').totalMinutes).toBe(90);
    expect(getTiming(CertType.AXIS, CertLevel.L1, '2.0').totalMinutes).toBe(120);
  });
});

describe('spec v3.0 — hard cuts (총점 60 + 40% 과락, L2 실습·L1 Part B 60%)', () => {
  const gatesFor = (level: CertLevel, pcts: Partial<Record<ExamPart, number>>) => {
    const scoring = getScoring(CertType.AXIS, level, '3.0');
    return computeWeightedResult(scoring, (p) => pcts[p] ?? 0);
  };

  it('L3: total ≥60 · 객관식 ≥24/60 (40%) · 실습 ≥16/40 (40%)', () => {
    const scoring = getScoring(CertType.AXIS, CertLevel.L3, '3.0');
    expect(scoring.passTotal).toBe(60);
    expect(scoring.totalGateKey).toBe('total_score_min_60');
    const keys = scoring.sections.map((s) => s.gateKey);
    expect(keys).toEqual(['objective_score_min_24', 'practice_score_min_16']);

    // 객관식 24/60 = 40% and 실습 16/40 = 40% both exactly clear.
    const ok = gatesFor(CertLevel.L3, { [ExamPart.WRITTEN]: 100, [ExamPart.PRACTICAL]: 40 });
    expect(ok.gateResults['practice_score_min_16']).toBe(true);
    // 실습 15/40 = 37.5% fails the 40% floor even with a perfect MCQ (non-compensatory).
    const fail = gatesFor(CertLevel.L3, { [ExamPart.WRITTEN]: 100, [ExamPart.PRACTICAL]: 37.5 });
    expect(fail.gateResults['practice_score_min_16']).toBe(false);
    expect(fail.passed).toBe(false);
  });

  it('L2: total ≥60 · 객관식 ≥12/30 (40%) · 실습 ≥42/70 (60% 불변)', () => {
    const scoring = getScoring(CertType.AXIS, CertLevel.L2, '3.0');
    expect(scoring.passTotal).toBe(60);
    expect(scoring.sections.map((s) => s.gateKey)).toEqual([
      'objective_score_min_12',
      'practice_score_min_42',
    ]);
    expect(scoring.sections.find((s) => s.part === ExamPart.PRACTICAL)?.floorPct).toBe(60);
  });

  it('L1: adds the NEW Part C hard floor (8/20 = 40%)', () => {
    const scoring = getScoring(CertType.AXIS, CertLevel.L1, '3.0');
    expect(scoring.passTotal).toBe(60);
    expect(scoring.sections.map((s) => s.gateKey)).toEqual([
      'part_a_min_10',
      'part_b_min_33',
      'part_c_min_8',
    ]);
    // v2.0 had NO Part C floor — a 0-score Part C could still pass.
    const v2 = getScoring(CertType.AXIS, CertLevel.L1, '2.0');
    expect(v2.sections.find((s) => s.part === ExamPart.ESSAY)?.floorPct).toBeNull();

    // Part C 7/20 = 35% → below the new 40% floor ⇒ fail, regardless of A/B.
    const r = gatesFor(CertLevel.L1, {
      [ExamPart.WRITTEN]: 100,
      [ExamPart.DELIVERABLE]: 100,
      [ExamPart.ESSAY]: 35,
    });
    expect(r.gateResults['part_c_min_8']).toBe(false);
    expect(r.passed).toBe(false);
  });
});

describe('spec v3.0 — L3 draws 8 practical items (2 per type)', () => {
  it('getExamSpec returns 8 under 3.0 and 4 under 2.0', () => {
    expect(getExamSpec(CertType.AXIS, CertLevel.L3, '3.0').practicalTaskCount).toBe(8);
    expect(getExamSpec(CertType.AXIS, CertLevel.L3, '2.0').practicalTaskCount).toBe(4);
    expect(getExamSpec(CertType.AXIS, CertLevel.L3, '3.0').writtenQuestionCount).toBe(40);
  });
});

describe('spec v3.0 — review bands (55~64 총점, verbatim schema enums)', () => {
  it('L3: 실습 과락(16 미만) + 객관식 경계밴드(20~28) fire on the ×0.5 scale', () => {
    const r = sessionReviewV2(
      CertLevel.L3,
      { total: 58, objective: 24, practice: 15 }, // practice already ×0.5 환산 (0–40)
      '3.0',
    );
    expect(r.reviewReasons).toContain('총점 경계밴드(55~64)');
    expect(r.reviewReasons).toContain('객관식 경계밴드(20~28)');
    expect(r.reviewReasons).toContain('실습형 과락(16 미만)');
    expect(r.humanReviewRequired).toBe(true);
  });

  it('L1: the new Part C band + hard-floor reasons fire', () => {
    const r = sessionReviewV2(
      CertLevel.L1,
      { total: 60, objective: 15, practice: 40, partC: 7 },
      '3.0',
    );
    expect(r.reviewReasons).toContain('Part C 경계밴드(6~10)');
    expect(r.reviewReasons).toContain('Part C 최저기준 미달(8 미만)');
    expect(r.reviewReasons).toContain('Part C 추가 검수(12 미만)');
  });

  it('v2.0 band strings still apply to v2.0 sessions (regression)', () => {
    const r = sessionReviewV2(CertLevel.L3, { total: 70, objective: 40, practice: 24 }, '2.0');
    expect(r.reviewReasons).toContain('총점 경계권(65~74)');
  });

  it('every v3 reason string is in the shipped schema enum (ajv would reject otherwise)', () => {
    const enumOf = (level: 'L1' | 'L2' | 'L3') =>
      (SESSION_AGGREGATE_SCHEMAS_BY_SPEC['3.0'][level] as any).properties.review.properties
        .review_reasons.items.enum as string[];
    for (const level of ['L1', 'L2', 'L3'] as const) {
      const allowed = enumOf(level);
      for (const reason of Object.values(REVIEW_REASONS_V3[level])) {
        expect(allowed).toContain(reason);
      }
    }
  });

  it('band cut values match the gate key names', () => {
    expect(REVIEW_BANDS_V3.L3.objectiveMin).toBe(24);
    expect(REVIEW_BANDS_V3.L3.practiceMin).toBe(16);
    expect(REVIEW_BANDS_V3.L2.objectiveMin).toBe(12);
    expect(REVIEW_BANDS_V3.L1.partAMin).toBe(10);
    expect(REVIEW_BANDS_V3.L1.partCMin).toBe(8);
  });
});

describe('spec v3.0 — session-aggregate schemas', () => {
  it('declares the per-level schema_version the records must carry', () => {
    expect(SESSION_AGGREGATE_SCHEMA_VERSIONS['3.0']).toEqual({ L1: '1.2', L2: '1.1', L3: '1.0' });
    expect(SESSION_AGGREGATE_SCHEMA_VERSIONS['2.0']).toEqual({ L1: '1.1', L2: '1.0', L3: '1.0' });
  });

  it('the shipped v3 schemas pin the confirmed times, gates and the 8-item L3 paper', () => {
    const s = SESSION_AGGREGATE_SCHEMAS_BY_SPEC['3.0'] as any;
    expect(s.L3.properties.exam_session.properties.exam_time_limit_minutes.const).toBe(90);
    expect(s.L2.properties.exam_session.properties.exam_time_limit_minutes.const).toBe(120);
    expect(s.L1.properties.exam_session.properties.exam_time_limit_minutes.const).toBe(150);
    expect(s.L3.properties.practice_item_refs.minItems).toBe(8);
    expect(s.L3.properties.practice_item_refs.maxItems).toBe(8);
    expect(Object.keys(s.L1.properties.gate_results.properties)).toContain('part_c_min_8');
  });
});

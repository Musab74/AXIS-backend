/**
 * 시험 표준 v2.0 gate/floor matrix (WP2) + boundary review bands (WP3).
 * Pure-function tests — no DB / Nest DI.
 */
import { CertLevel, CertType, ExamPart } from '@prisma/client';
import {
  computeWeightedResult,
  getScoring,
  getTiming,
  GATE_KEYS,
  toSpecVersion,
  currentSpecVersion,
} from '../cbtSessions/exam-spec';
import {
  INTERNAL_REVIEW_REASONS_V2,
  REVIEW_BANDS_V2,
  REVIEW_REASONS_V2,
  sessionReviewV2,
} from './review-bands';

describe('exam-spec v2.0 hard cuts (WP2)', () => {
  const prevFlag = process.env.L3_PRACTICALS_ENABLED;
  beforeAll(() => {
    process.env.L3_PRACTICALS_ENABLED = 'true';
  });
  afterAll(() => {
    if (prevFlag === undefined) delete process.env.L3_PRACTICALS_ENABLED;
    else process.env.L3_PRACTICALS_ENABLED = prevFlag;
  });

  const pct =
    (written: number, practice: number, essay?: number) =>
    (part: ExamPart): number =>
      part === ExamPart.WRITTEN ? written : part === ExamPart.ESSAY ? (essay ?? practice) : practice;

  describe('L3', () => {
    it('adds the 50% written hard cut (30/60) for v2.0 only', () => {
      const v2 = getScoring(CertType.AXIS, CertLevel.L3, '2.0');
      expect(v2.sections.find((s) => s.part === ExamPart.WRITTEN)?.floorPct).toBe(50);
      const v1 = getScoring(CertType.AXIS, CertLevel.L3, '1.1');
      expect(v1.sections.find((s) => s.part === ExamPart.WRITTEN)?.floorPct).toBeNull();
    });

    it('fails on the MCQ gate even when the total clears 70', () => {
      const scoring = getScoring(CertType.AXIS, CertLevel.L3, '2.0');
      // written 49.5% (29.7/60) + practical 100% (40/40) → total 70 (rounded)
      const r = computeWeightedResult(scoring, pct(49.5, 100));
      expect(r.total).toBe(70);
      expect(r.passed).toBe(false);
      expect(r.gateResults[GATE_KEYS.TOTAL]).toBe(true);
      expect(r.gateResults[GATE_KEYS.L3_OBJECTIVE]).toBe(false);
      expect(r.failedGates).toEqual([GATE_KEYS.L3_OBJECTIVE]);
    });

    it('keeps the practical 24/40 gate and passes exactly at the cuts', () => {
      const scoring = getScoring(CertType.AXIS, CertLevel.L3, '2.0');
      // written 50% (30/60) + practical 100% → total 70: every gate exactly met.
      const boundary = computeWeightedResult(scoring, pct(50, 100));
      expect(boundary.passed).toBe(true);
      const floorFail = computeWeightedResult(scoring, pct(100, 55));
      expect(floorFail.passed).toBe(false);
      expect(floorFail.gateResults[GATE_KEYS.L3_PRACTICE]).toBe(false);
    });
  });

  describe('L2', () => {
    it('keeps 15/30 + 42/70 with v2.0 gate keys', () => {
      const scoring = getScoring(CertType.AXIS, CertLevel.L2, '2.0');
      const mcqFail = computeWeightedResult(scoring, pct(40, 90)); // MCQ 12/30
      expect(mcqFail.passed).toBe(false);
      expect(mcqFail.gateResults[GATE_KEYS.L2_OBJECTIVE]).toBe(false);
      const practiceFail = computeWeightedResult(scoring, pct(100, 55)); // 38.5/70
      expect(practiceFail.gateResults[GATE_KEYS.L2_PRACTICE]).toBe(false);
      const clean = computeWeightedResult(scoring, pct(80, 80));
      expect(clean.passed).toBe(true);
      expect(clean.failedGates).toEqual([]);
    });
  });

  describe('L1', () => {
    it('adds the Part A 13/25 hard cut for v2.0', () => {
      const scoring = getScoring(CertType.AXIS, CertLevel.L1, '2.0');
      const r = computeWeightedResult(scoring, pct(48, 100)); // Part A 12/25
      expect(r.passed).toBe(false);
      expect(r.gateResults[GATE_KEYS.L1_PART_A]).toBe(false);
      // 13/25 = 52% exactly clears the cut.
      const boundary = computeWeightedResult(scoring, pct(52, 100));
      expect(boundary.gateResults[GATE_KEYS.L1_PART_A]).toBe(true);
    });

    it('REMOVES the Part C floor: total 71 with Part C 10/20 passes', () => {
      const scoring = getScoring(CertType.AXIS, CertLevel.L1, '2.0');
      expect(scoring.sections.find((s) => s.part === ExamPart.ESSAY)?.floorPct).toBeNull();
      // A 19/25 (76%) + B 42/55 (76.36%) + C 10/20 (50%) = 71
      const r = computeWeightedResult(scoring, (part) =>
        part === ExamPart.WRITTEN ? 76 : part === ExamPart.DELIVERABLE ? 76.3636 : 50,
      );
      expect(r.total).toBe(71);
      expect(r.passed).toBe(true);
      expect(r.floorFailures).toEqual([]);
    });

    it('v1.1 keeps the essay floor (regression: in-flight sessions unchanged)', () => {
      const scoring = getScoring(CertType.AXIS, CertLevel.L1, '1.1');
      expect(scoring.sections.find((s) => s.part === ExamPart.ESSAY)?.floorPct).toBe(60);
      const r = computeWeightedResult(scoring, (part) => (part === ExamPart.ESSAY ? 50 : 100));
      expect(r.passed).toBe(false);
      expect(r.floorFailures).toContain(ExamPart.ESSAY);
      expect(r.gateResults).toEqual({}); // no gate keys on v1.1
    });
  });

  describe('timing (WP1)', () => {
    it('v2.0 L3 = 70 min (50 written + 20 practical); v1.1 stays 60', () => {
      expect(getTiming(CertType.AXIS, CertLevel.L3, '2.0')).toMatchObject({
        totalMinutes: 70,
        writtenMinutes: 50,
        practicalMinutes: 20,
      });
      expect(getTiming(CertType.AXIS, CertLevel.L3, '1.1')).toMatchObject({
        totalMinutes: 60,
        writtenMinutes: 40,
      });
    });

    it('legacy MCQ-only L3 stays 60 min even on v2.0', () => {
      process.env.L3_PRACTICALS_ENABLED = 'false';
      expect(getTiming(CertType.AXIS, CertLevel.L3, '2.0').totalMinutes).toBe(60);
      process.env.L3_PRACTICALS_ENABLED = 'true';
    });

    it('spec-version helpers normalize unknown values to 1.1', () => {
      expect(toSpecVersion('2.0')).toBe('2.0');
      expect(toSpecVersion('1.1')).toBe('1.1');
      expect(toSpecVersion(null)).toBe('1.1');
      expect(toSpecVersion('9.9')).toBe('1.1');
      expect(['1.1', '2.0']).toContain(currentSpecVersion());
    });
  });
});

describe('review bands v2.0 (WP3)', () => {
  it('L3: total boundary 65–74 inclusive', () => {
    const at = (total: number) =>
      sessionReviewV2(CertLevel.L3, { total, objective: 50, practice: 30 });
    expect(at(64).reviewReasons).not.toContain(REVIEW_REASONS_V2.L3.TOTAL_BAND);
    expect(at(65).reviewReasons).toContain(REVIEW_REASONS_V2.L3.TOTAL_BAND);
    expect(at(74).reviewReasons).toContain(REVIEW_REASONS_V2.L3.TOTAL_BAND);
    expect(at(75).reviewReasons).not.toContain(REVIEW_REASONS_V2.L3.TOTAL_BAND);
  });

  it('L3: practical band 22–26, below-cut reasons, risk-type ≤5', () => {
    const r = sessionReviewV2(CertLevel.L3, {
      total: 80,
      objective: 29,
      practice: 23,
      taskScores: [{ key: 't4', score: 5, max: 10, isRiskJudgementType: true }],
    });
    expect(r.reviewReasons).toEqual(
      expect.arrayContaining([
        REVIEW_REASONS_V2.L3.PRACTICE_BAND,
        REVIEW_REASONS_V2.L3.PRACTICE_BELOW_MIN,
        REVIEW_REASONS_V2.L3.OBJECTIVE_BELOW_MIN,
        REVIEW_REASONS_V2.L3.RISK_TASK_LOW,
      ]),
    );
    expect(r.humanReviewRequired).toBe(true);
  });

  it('L2: per-task <40% flags use each task max (A<10, B<10, C<8)', () => {
    const r = sessionReviewV2(CertLevel.L2, {
      total: 80,
      objective: 25,
      practice: 50,
      taskScores: [
        { key: 'task_A', score: 9, max: 25 }, // 36% → flagged
        { key: 'task_B', score: 10, max: 25 }, // 40% → NOT below
        { key: 'task_C', score: 7, max: 20 }, // 35% → flagged
      ],
    });
    expect(r.tasksBelow40Pct).toEqual(['task_A', 'task_C']);
    expect(r.reviewReasons).toContain(REVIEW_REASONS_V2.L2.TASK_BELOW_40PCT);
  });

  it('L2: objective 13–17 and practical 38–45 bands + below-cut strings', () => {
    const r = sessionReviewV2(CertLevel.L2, { total: 80, objective: 14, practice: 41 });
    expect(r.reviewReasons).toEqual(
      expect.arrayContaining([
        REVIEW_REASONS_V2.L2.OBJECTIVE_BAND,
        REVIEW_REASONS_V2.L2.PRACTICE_BAND,
        REVIEW_REASONS_V2.L2.OBJECTIVE_BELOW_MIN,
        REVIEW_REASONS_V2.L2.PRACTICE_BELOW_MIN,
      ]),
    );
  });

  it('L1: Part C < 12 is an INTERNAL review trigger, not a schema reason', () => {
    const r = sessionReviewV2(CertLevel.L1, { total: 80, objective: 20, practice: 45, partC: 11 });
    expect(r.humanReviewRequired).toBe(true);
    expect(r.internalReasons).toContain(INTERNAL_REVIEW_REASONS_V2.L1_PART_C_LOW);
    expect(r.reviewReasons).not.toContain(INTERNAL_REVIEW_REASONS_V2.L1_PART_C_LOW);
    // Exactly 12 does not trigger.
    const ok = sessionReviewV2(CertLevel.L1, { total: 80, objective: 20, practice: 45, partC: 12 });
    expect(ok.internalReasons).toEqual([]);
  });

  it('flag-driven reasons map to each level’s enum strings', () => {
    const l3 = sessionReviewV2(CertLevel.L3, {
      total: 85, objective: 50, practice: 35,
      gateTriggered: true, riskFlagged: true, criticalRisk: true,
      lowConfidence: true, injectionSuspected: true, appealFiled: true,
    });
    expect(l3.reviewReasons).toEqual(
      expect.arrayContaining([
        '게이트 발동 문항 존재', '위험 플래그', 'critical 위험',
        'confidence 0.75 미만 문항 존재', '인젝션 의심', '이의신청',
      ]),
    );
    const l2 = sessionReviewV2(CertLevel.L2, {
      total: 85, objective: 25, practice: 55,
      gateTriggered: true, criticalFail: true, lowConfidence: true,
    });
    expect(l2.reviewReasons).toEqual(
      expect.arrayContaining([
        '산출물-검증 게이트 발동', '치명 실패 패턴', 'confidence 0.75 미만 과제 존재',
      ]),
    );
    const l1 = sessionReviewV2(CertLevel.L1, {
      total: 85, objective: 20, practice: 45, partC: 15,
      gateTriggered: true, criticalFail: true, similarityTop: true,
    });
    expect(l1.reviewReasons).toEqual(
      expect.arrayContaining(['계획-리스크 게이트 발동', '치명 실패 패턴', '제출물 유사도 상위']),
    );
  });

  it('clean sessions require no review', () => {
    expect(
      sessionReviewV2(CertLevel.L3, { total: 85, objective: 50, practice: 35 }).humanReviewRequired,
    ).toBe(false);
    expect(
      sessionReviewV2(CertLevel.L2, { total: 85, objective: 25, practice: 60 }).humanReviewRequired,
    ).toBe(false);
    expect(
      sessionReviewV2(CertLevel.L1, { total: 85, objective: 20, practice: 45, partC: 15 })
        .humanReviewRequired,
    ).toBe(false);
  });

  it('band config matches the aggregate schemas', () => {
    expect(REVIEW_BANDS_V2.L3).toMatchObject({ practiceMin: 24, objectiveMin: 30 });
    expect(REVIEW_BANDS_V2.L2).toMatchObject({ objectiveMin: 15, practiceMin: 42 });
    expect(REVIEW_BANDS_V2.L1).toMatchObject({ partAMin: 13, partBMin: 33, partCReviewBelow: 12 });
  });
});

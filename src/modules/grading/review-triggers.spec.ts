import { ExamPart } from '@prisma/client';
import { LevelScoring } from '../cbtSessions/exam-spec';
import {
  computeMandatoryReview,
  hasEscalatedRiskFlags,
  isScoreDisputed,
  sessionReviewFromTaskPcts,
  sessionTriggersReview,
  taskTriggersReview,
} from './review-triggers';

describe('isScoreDisputed (FIX 1 — expert raw points vs AI pct, same scale)', () => {
  it('L2 30-pt task: expert 24/30 (80%) vs AI 80% → NOT disputed', () => {
    expect(isScoreDisputed(24, 80, 30)).toBe(false);
  });

  it('L2 30-pt task: expert 12/30 (40%) vs AI 80% → disputed', () => {
    expect(isScoreDisputed(12, 80, 30)).toBe(true);
  });

  it('L3 10-pt task: expert 9/10 (90%) vs AI 90% → NOT disputed', () => {
    expect(isScoreDisputed(9, 90, 10)).toBe(false);
  });

  it('L3 10-pt task: expert 4/10 (40%) vs AI 90% → disputed', () => {
    expect(isScoreDisputed(4, 90, 10)).toBe(true);
  });

  it('uses >= : a gap of exactly 15pp IS disputed', () => {
    expect(isScoreDisputed(13, 80, 20)).toBe(true); // 65% vs 80% = 15pp
  });

  it('a gap just under 15pp is NOT disputed', () => {
    expect(isScoreDisputed(20, 80, 30)).toBe(false); // 66.67% vs 80% ≈ 13.3pp
  });

  it('null scores or unknown/zero task points → never disputed', () => {
    expect(isScoreDisputed(null, 80, 30)).toBe(false);
    expect(isScoreDisputed(24, null, 30)).toBe(false);
    expect(isScoreDisputed(24, 80, undefined)).toBe(false);
    expect(isScoreDisputed(24, 80, 0)).toBe(false);
  });
});

describe('taskTriggersReview (FIX 2 — numeric triggers on top of band/confidence)', () => {
  const base = { scored: true, confidence: 0.9, riskFlags: 0 };

  it('42% reported as band "normal" with L2 practical floor 60 → STILL review', () => {
    expect(taskTriggersReview({ ...base, pct: 42, band: 'normal', floorPct: 60 })).toBe(true);
  });

  it('80% band "normal" clear of the floor → no review', () => {
    expect(taskTriggersReview({ ...base, pct: 80, band: 'normal', floorPct: 60 })).toBe(false);
  });

  it('pct < 40 triggers even without a section floor', () => {
    expect(taskTriggersReview({ ...base, pct: 38, band: 'normal', floorPct: null })).toBe(true);
  });

  it('within ±5pp of the floor (63 vs 60) → review', () => {
    expect(taskTriggersReview({ ...base, pct: 63, band: 'normal', floorPct: 60 })).toBe(true);
  });

  it('band borderline/fail → review regardless of pct', () => {
    expect(taskTriggersReview({ ...base, pct: 90, band: 'borderline', floorPct: 60 })).toBe(true);
    expect(taskTriggersReview({ ...base, pct: 90, band: 'fail', floorPct: 60 })).toBe(true);
  });

  it('confidence below 0.75 → review', () => {
    expect(
      taskTriggersReview({ scored: true, pct: 90, band: 'normal', confidence: 0.7, floorPct: 60 }),
    ).toBe(true);
  });

  it('any risk flag → review', () => {
    expect(
      taskTriggersReview({ ...base, pct: 90, band: 'normal', riskFlags: 1, floorPct: 60 }),
    ).toBe(true);
  });

  it('forceReview counts even when the task could not be scored (Judge0-less code)', () => {
    expect(taskTriggersReview({ scored: false, forceReview: true })).toBe(true);
    expect(computeMandatoryReview([{ scored: false, forceReview: true }])).toBe(true);
  });

  it('unscored (degraded) task without forceReview → no trigger', () => {
    expect(taskTriggersReview({ scored: false })).toBe(false);
  });
});

const L2_SCORING: LevelScoring = {
  passTotal: 70,
  sections: [
    { part: ExamPart.WRITTEN, weight: 30, floorPct: 50 },
    { part: ExamPart.PRACTICAL, weight: 70, floorPct: 60 },
  ],
};

describe('sessionTriggersReview / sessionReviewFromTaskPcts (session-level windows)', () => {
  it('total inside the 65–74 pass boundary window → review', () => {
    expect(sessionTriggersReview(70, 65, [])).toBe(true);
    expect(sessionTriggersReview(70, 74, [])).toBe(true);
    expect(sessionTriggersReview(70, 75, [])).toBe(false);
    expect(sessionTriggersReview(70, 64, [])).toBe(false);
  });

  it('a practical section near or below its floor → review', () => {
    const near = [{ part: ExamPart.PRACTICAL, pct: 63, floorPct: 60 }];
    const below = [{ part: ExamPart.PRACTICAL, pct: 40, floorPct: 60 }];
    const clear = [{ part: ExamPart.PRACTICAL, pct: 80, floorPct: 60 }];
    expect(sessionTriggersReview(70, 90, near)).toBe(true);
    expect(sessionTriggersReview(70, 90, below)).toBe(true);
    expect(sessionTriggersReview(70, 90, clear)).toBe(false);
  });

  it('L2: written 90 + strong practical (three 90% tasks) → no review', () => {
    const tasks = [
      { id: 'a', part: ExamPart.PRACTICAL, points: 30 },
      { id: 'b', part: ExamPart.PRACTICAL, points: 30 },
      { id: 'c', part: ExamPart.PRACTICAL, points: 40 },
    ];
    const pcts = new Map([['a', 90], ['b', 90], ['c', 90]]);
    expect(sessionReviewFromTaskPcts(L2_SCORING, 90, tasks, pcts)).toBe(false);
  });

  it('L2: practical section landing at 62% (within 60±5 floor band) → review', () => {
    const tasks = [
      { id: 'a', part: ExamPart.PRACTICAL, points: 30 },
      { id: 'b', part: ExamPart.PRACTICAL, points: 30 },
      { id: 'c', part: ExamPart.PRACTICAL, points: 40 },
    ];
    const pcts = new Map([['a', 62], ['b', 62], ['c', 62]]);
    expect(sessionReviewFromTaskPcts(L2_SCORING, 90, tasks, pcts)).toBe(true);
  });
});

describe('hasEscalatedRiskFlags (FIX 4 — AXIS-H severity ladder)', () => {
  it('CRITICAL or HIGH severity → escalated', () => {
    expect(hasEscalatedRiskFlags([{ code: 'treatment', severity: 'CRITICAL', detail: '' }])).toBe(true);
    expect(hasEscalatedRiskFlags([{ code: 'diagnosis', severity: 'HIGH', detail: '' }])).toBe(true);
  });

  it('LOW/MED only → not escalated', () => {
    expect(
      hasEscalatedRiskFlags([
        { code: 'overclaim', severity: 'MED', detail: '' },
        { code: 'minor', severity: 'LOW', detail: '' },
      ]),
    ).toBe(false);
  });

  it('non-array / empty / malformed JSON values → not escalated', () => {
    expect(hasEscalatedRiskFlags(null)).toBe(false);
    expect(hasEscalatedRiskFlags([])).toBe(false);
    expect(hasEscalatedRiskFlags({ severity: 'HIGH' })).toBe(false);
    expect(hasEscalatedRiskFlags([null, { severity: 42 }])).toBe(false);
  });
});

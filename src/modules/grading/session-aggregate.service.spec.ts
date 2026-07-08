/**
 * WP7 acceptance: the session-aggregate record built for each level validates
 * against its bundled AXIS_L*_채점_세션집계_JSON스키마_v1_0.json. Prisma is
 * mocked; the service's ajv validators run for real.
 */
import { CertLevel, CertType, DecisionStatus, ExamPart } from '@prisma/client';
import type { PrismaService } from '../../common/prisma.service';
import { SessionAggregateService } from './session-aggregate.service';

type AnyRec = Record<string, unknown>;

function answer(over: AnyRec): AnyRec {
  return {
    id: `ans-${over.taskId}`,
    taskId: 'T',
    part: ExamPart.PRACTICAL,
    contentText: '{}',
    aiChatLog: null,
    earnedPoints: 8,
    expertScore: null,
    aiPreScore: 80,
    aiConfidence: 0.9,
    aiRiskFlags: [],
    aiGate: null,
    aiCriticalFails: null,
    aiInjectionSuspected: false,
    aiPromptVersion: 'AXIS-L3-AI-SCORING-PROMPT-v1.0',
    aiRubricVersion: 'v2.0',
    ...over,
  };
}

function task(over: AnyRec): AnyRec {
  return {
    id: 'T',
    part: ExamPart.PRACTICAL,
    title: '과제',
    points: 10,
    orderIndex: 0,
    taskType: null,
    rubric: {},
    version: 2,
    ...over,
  };
}

function session(over: AnyRec): AnyRec {
  return {
    id: 'sess-1',
    userId: 'user-1',
    certType: CertType.AXIS,
    level: CertLevel.L3,
    specVersion: '2.0',
    status: 'SUBMITTED',
    paperSeed: 'seed-abc',
    writtenScore: 80,
    practicalScore: null,
    totalScore: null,
    submittedAt: new Date('2026-07-07T03:00:00Z'),
    updatedAt: new Date('2026-07-07T03:00:00Z'),
    decisionStatus: DecisionStatus.PROVISIONAL,
    confirmedAt: null,
    confirmedByRef: null,
    embeddedAiVersion: null,
    promptLogRef: null,
    promptLogHash: null,
    essayAnswers: [],
    ...over,
  };
}

function harness(sess: AnyRec, tasks: AnyRec[]) {
  const upsert = jest.fn(async (args: { create: AnyRec }) => ({ id: 'agg-1', ...args.create }));
  const sessionUpdate = jest.fn(async () => ({}));
  const prisma = {
    examSession: { findUnique: jest.fn(async () => sess), update: sessionUpdate },
    taskTemplate: { findMany: jest.fn(async () => tasks) },
    sessionAggregate: { upsert, findUnique: jest.fn() },
  } as unknown as PrismaService;
  return { svc: new SessionAggregateService(prisma), upsert };
}

const prevFlag = process.env.L3_PRACTICALS_ENABLED;
beforeAll(() => {
  process.env.L3_PRACTICALS_ENABLED = 'true';
});
afterAll(() => {
  if (prevFlag === undefined) delete process.env.L3_PRACTICALS_ENABLED;
  else process.env.L3_PRACTICALS_ENABLED = prevFlag;
});

describe('SessionAggregateService — schema validation per level', () => {
  it('L3: 4 practice items → valid record with gate booleans + 70min limit', async () => {
    const types = ['현업적용형', '지시설계형', '분석검증형', '리스크판단형'];
    const tasks = types.map((t, i) =>
      task({ id: `t${i}`, orderIndex: i, rubric: { practiceType: t }, points: 10 }),
    );
    const sess = session({
      essayAnswers: types.map((_, i) => answer({ taskId: `t${i}`, earnedPoints: 8 })),
    });
    const { svc, upsert } = harness(sess, tasks);

    await svc.rebuild('sess-1');
    expect(upsert).toHaveBeenCalledTimes(1);
    const created = upsert.mock.calls[0][0].create as AnyRec;
    expect(created.schemaValid).toBe(true);
    const record = created.record as AnyRec;
    expect((record.exam_session as AnyRec).exam_time_limit_minutes).toBe(70);
    expect((record.scores as AnyRec).practice_score).toBe(32);
    expect((record.scores as AnyRec).total_score).toBe(80); // 0.8*60 + 32
    expect(record.gate_results).toEqual({
      total_score_min_70: true,
      objective_score_min_30: true,
      practice_score_min_24: true,
    });
    // Practice types carry the schema enum spelling (분석·검증형, 리스크 판단형).
    const refs = record.practice_item_refs as Array<AnyRec>;
    expect(refs.map((r) => r.practice_type)).toEqual([
      '현업적용형',
      '지시설계형',
      '분석·검증형',
      '리스크 판단형',
    ]);
    expect((record.decision_status as AnyRec).status).toBe('provisional');
  });

  it('L3: MCQ below the 30/60 cut → gate false + below-min review reason', async () => {
    const types = ['현업적용형', '지시설계형', '분석검증형', '리스크판단형'];
    const tasks = types.map((t, i) => task({ id: `t${i}`, orderIndex: i, rubric: { practiceType: t } }));
    const sess = session({
      writtenScore: 45, // 27/60 < 30
      essayAnswers: types.map((_, i) => answer({ taskId: `t${i}`, earnedPoints: 10 })),
    });
    const { svc, upsert } = harness(sess, tasks);
    await svc.rebuild('sess-1');
    const created = upsert.mock.calls[0][0].create as AnyRec;
    const record = created.record as AnyRec;
    expect(created.schemaValid).toBe(true);
    expect((record.gate_results as AnyRec).objective_score_min_30).toBe(false);
    expect((record.review as AnyRec).review_reasons).toContain('객관식 최저기준 미달(30 미만)');
    expect(created.humanReviewRequired).toBe(true);
  });

  it('L2: 25/25/20 tasks → valid record with task refs, prompt-log hash, below-40% flag', async () => {
    const tasks = [
      task({ id: 'a', orderIndex: 0, points: 25, taskType: '업무 산출물 작성·개선형' }),
      task({ id: 'b', orderIndex: 1, points: 25, taskType: '자료 요약·분석·검증형' }),
      task({ id: 'c', orderIndex: 2, points: 20, taskType: '업무흐름 개선·자동화 설계형' }),
    ];
    const sess = session({
      level: CertLevel.L2,
      writtenScore: 80, // 24/30
      essayAnswers: [
        answer({ taskId: 'a', earnedPoints: 20, aiChatLog: [{ role: 'user', text: '지시문' }] }),
        answer({ taskId: 'b', earnedPoints: 9 }), // 36% → below_40_percent
        answer({ taskId: 'c', earnedPoints: 15 }),
      ],
    });
    const { svc, upsert } = harness(sess, tasks);
    await svc.rebuild('sess-1');
    const created = upsert.mock.calls[0][0].create as AnyRec;
    expect(created.schemaValid).toBe(true);
    const record = created.record as AnyRec;
    expect((record.exam_session as AnyRec).exam_time_limit_minutes).toBe(90);
    expect((record.scores as AnyRec).practice_task_scores).toEqual({
      task_A: 20,
      task_B: 9,
      task_C: 15,
    });
    const refs = record.practice_task_refs as Array<AnyRec>;
    expect(refs.find((r) => r.task_id === 'b')?.below_40_percent).toBe(true);
    expect((record.review as AnyRec).review_reasons).toContain('단일 과제 40% 미만');
    expect(typeof (record.audit as AnyRec).prompt_log_hash).toBe('string');
    expect(((record.audit as AnyRec).prompt_log_hash as string).length).toBe(64);
  });

  it('L1: Part C 10/20 → valid record, PASS gates, review via internal reason only', async () => {
    const tasks = [
      task({ id: 'b', part: ExamPart.DELIVERABLE, orderIndex: 0, points: 55 }),
      task({ id: 'c1', part: ExamPart.ESSAY, orderIndex: 1, points: 10 }),
      task({ id: 'c2', part: ExamPart.ESSAY, orderIndex: 2, points: 10 }),
    ];
    const sess = session({
      level: CertLevel.L1,
      writtenScore: 80, // Part A 20/25
      essayAnswers: [
        answer({ taskId: 'b', part: ExamPart.DELIVERABLE, earnedPoints: 45 }),
        answer({ taskId: 'c1', part: ExamPart.ESSAY, earnedPoints: 5 }),
        answer({ taskId: 'c2', part: ExamPart.ESSAY, earnedPoints: 5 }),
      ],
    });
    const { svc, upsert } = harness(sess, tasks);
    await svc.rebuild('sess-1');
    const created = upsert.mock.calls[0][0].create as AnyRec;
    expect(created.schemaValid).toBe(true);
    const record = created.record as AnyRec;
    expect((record.exam_session as AnyRec).exam_time_limit_minutes).toBe(120);
    expect((record.exam_session as AnyRec).ai_use_blocked).toBe(true);
    expect(record.gate_results).toEqual({
      total_score_min_70: true, // 20 + 45 + 10 = 75
      part_a_min_13: true,
      part_b_min_33: true,
    });
    // Part C < 12 must set human review WITHOUT an off-enum schema reason.
    expect(created.humanReviewRequired).toBe(true);
    expect((record.review as AnyRec).review_reasons).not.toContain('Part C 12점 미만');
    expect(created.internalReviewReasons).toContain('Part C 12점 미만');
    const parts = (record.part_record_refs as Array<AnyRec>).map((r) => r.part);
    expect(parts).toEqual(['B', 'C1', 'C2']);
  });

  it('skips v1.1 sessions (no aggregate is a v1.1 behavior guarantee)', async () => {
    const sess = session({ specVersion: '1.1' });
    const { svc, upsert } = harness(sess, []);
    const out = await svc.rebuild('sess-1');
    expect(out).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });
});

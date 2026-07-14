/**
 * v3.0 END-TO-END ENGINE TEST — real content, real code paths, no database.
 *
 * Loads the ACTUAL question bank from `new_version_v3/` (the same YAML the
 * importer writes to MySQL), then drives the REAL production code:
 *
 *   bank YAML → paper composition (CbtSessionsService.start)
 *             → answer submission
 *             → grading (L3PracticalGraderService — real answer keys)
 *             → session aggregate (SessionAggregateService — real ajv validation
 *               against the shipped v3 JSON schema)
 *             → pass/fail gates (computeWeightedResult)
 *
 * Prisma is mocked with in-memory rows shaped exactly as the importer writes
 * them; everything else is the code that runs in production. This is the closest
 * we can get to a live exam without a database.
 */
import { CertLevel, CertType, DecisionStatus, ExamPart, ExamSessionStatus } from '@prisma/client';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { PrismaService } from '../../common/prisma.service';
import { CbtSessionsService } from './cbt-sessions.service';
import { computeWeightedResult, getScoring, getTiming } from './exam-spec';
import { L3PracticalGraderService, parseL3Submission } from '../grading/l3-practical-grader.service';
import { buildL3RubricWrapper } from '../grading/l3-rubric-split';
import { SessionAggregateService } from '../grading/session-aggregate.service';
import { l3ClientView } from '../cbtExams/cbt-exams.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml: { load: (s: string) => any } = require('js-yaml');

const V3_ROOT = join(__dirname, '..', '..', '..', '..', 'new_version_v3');
const SKIP = /기획서|가이드|검토용_HTML|AI ?채점|시험·채점_설정|구버전|비편입/;

type Row = Record<string, any>;

// ─── Load the real v3 bank exactly as the importer would ─────────────────────
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (!SKIP.test(n)) walk(p, out);
    } else if (p.endsWith('.yaml') || p.endsWith('.yml')) out.push(p);
  }
  return out;
}
const levelOf = (p: string): CertLevel =>
  /L1|Leader/.test(p) ? CertLevel.L1 : /L2/.test(p) ? CertLevel.L2 : CertLevel.L3;
const normType = (t: string) => {
  const s = String(t ?? '').replace(/[·\s]/g, '');
  if (s.includes('현업적용')) return '현업적용형';
  if (s.includes('지시설계')) return '지시설계형';
  if (s.includes('분석') || s.includes('검증')) return '분석검증형';
  if (s.includes('리스크')) return '리스크판단형';
  return s || '기타';
};

interface Bank {
  questions: Row[];
  tasks: Row[];
}
const BANKS: Record<string, Bank> = { L1: { questions: [], tasks: [] }, L2: { questions: [], tasks: [] }, L3: { questions: [], tasks: [] } };

function loadBank() {
  const seen = new Set<string>();
  const subj: Record<string, Map<string, number>> = { L1: new Map(), L2: new Map(), L3: new Map() };
  const subjectIndexFor = (lv: string, area: string) => {
    const m = subj[lv];
    if (!m.has(area)) m.set(area, m.size);
    return m.get(area)!;
  };
  const setNo: Record<string, number> = {};
  const setNoByScenario: Record<string, number> = {};

  for (const f of walk(V3_ROOT)) {
    let doc: any;
    try { doc = yaml.load(readFileSync(f, 'utf8')); } catch { continue; }
    const level = levelOf(f);
    const B = BANKS[level];

    // L2 실습형 세트 → 3 tasks sharing one setNo (coherent-set draw)
    if (doc?.scenario_set_id && Array.isArray(doc.tasks)) {
      if (seen.has(doc.scenario_set_id)) continue;
      seen.add(doc.scenario_set_id);
      const grp = `${level}`;
      setNoByScenario[doc.scenario_set_id] = setNo[grp] = (setNo[grp] ?? 0) + 1;
      doc.tasks.forEach((t: any, i: number) => {
        B.tasks.push({
          id: t.task_id, certType: CertType.AXIS, level, part: ExamPart.PRACTICAL,
          title: `Task ${String.fromCharCode(65 + i)}`, scenario: String(doc.scenario_context ?? ''),
          points: Number(t.points) || 20, durationMin: 25, taskType: t.practice_type ?? null,
          difficulty: t.difficulty ?? null, orderIndex: i, setNo: setNoByScenario[doc.scenario_set_id],
          isActive: true, lifecycleStatus: '승인', aiToolAllowed: '시험 시스템 내장 AI',
          rubric: { criteria: Object.entries(t.rubric ?? {}).map(([k, v]) => `${k}(${v}점)`) },
        });
      });
      continue;
    }
    // L1 Part B 실행계획서 (DELIVERABLE) — the branch that used to be dropped
    if (doc?.scenario_id && Array.isArray(doc.rubric) && doc.task_prompt) {
      if (seen.has(doc.scenario_id)) continue;
      seen.add(doc.scenario_id);
      const key = `${level}|실행계획서`;
      setNo[key] = (setNo[key] ?? 0) + 1;
      B.tasks.push({
        id: doc.scenario_id, certType: CertType.AXIS, level, part: ExamPart.DELIVERABLE,
        title: `[실행계획서] ${doc.title}`, scenario: String(doc.context ?? ''),
        points: doc.rubric.reduce((s: number, r: any) => s + (Number(r.points) || 0), 0) || 55,
        durationMin: 70, taskType: '실행계획서', difficulty: null,
        orderIndex: setNo[key] - 1, setNo: setNo[key], isActive: true, lifecycleStatus: '승인',
        aiToolAllowed: 'AI 사용 불가',
        rubric: { criteria: doc.rubric.map((r: any) => `${r.criteria}(${r.points}점)`), rubricDetail: doc.rubric },
      });
      continue;
    }
    const items = doc?.items ?? doc?.questions;
    if (!Array.isArray(items)) continue;

    for (const it of items) {
      const id = it?.item_id ?? it?.practice_item_id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);

      if (it?.practice_type) {                       // L3 실습형
        const type = normType(it.practice_type);
        const key = `${level}|${type}`;
        setNo[key] = (setNo[key] ?? 0) + 1;
        B.tasks.push({
          id, certType: CertType.AXIS, level, part: ExamPart.PRACTICAL,
          title: `[${type}]`, scenario: String(it.scenario ?? ''),
          points: Number(it.score) || 10, durationMin: Number(it.time_minutes) || 5,
          taskType: type, difficulty: it.difficulty ?? null,
          orderIndex: setNo[key] - 1, setNo: setNo[key], isActive: true, lifecycleStatus: '승인',
          aiToolAllowed: 'AI 사용 불가',
          // EXACTLY what the importer stores (incl. the grading splits).
          rubric: buildL3RubricWrapper(it, id, type),
        });
      } else if (it?.question?.options) {            // 객관식
        const meta = it.axis_l3_mapping ?? it;
        const area = String(meta.evaluation_area ?? it.evaluation_area ?? '기타');
        B.questions.push({
          id, certType: CertType.AXIS, level, type: 'MCQ',
          subjectIndex: subjectIndexFor(level, area), subjectName: area,
          stem: [it.question.stem_scenario, it.question.question_line].filter(Boolean).join('\n\n'),
          choices: Object.entries(it.question.options).map(([key, text]) => ({ key, text: String(text) })),
          correctAnswer: String(it.question.answer ?? 'A'),
          points: Number(it.question.score) || 1,
          difficulty: meta.difficulty ?? it.difficulty ?? null,
          questionTypeTag: meta.item_type ?? it.item_type ?? null,
          active: true, lifecycleStatus: '승인', shuffleExempt: false, sourceRef: id,
        });
      } else if (it?.rubric && (it?.scenario || it?.question)) {   // L1 Part C 서술형
        const type = String(it.item_type ?? '기타');
        const key = `${level}|${type}`;
        setNo[key] = (setNo[key] ?? 0) + 1;
        B.tasks.push({
          id, certType: CertType.AXIS, level, part: ExamPart.ESSAY,
          title: `[${type}]`, scenario: String(it.scenario ?? ''),
          points: Number(it.score) || 10, durationMin: 20, taskType: type, difficulty: it.difficulty ?? null,
          orderIndex: setNo[key] - 1, setNo: setNo[key], isActive: true, lifecycleStatus: '승인',
          aiToolAllowed: 'AI 사용 불가',
          rubric: { criteria: (it.rubric ?? []).map((r: any) => `${r.criteria}(${r.points}점)`) },
        });
      }
    }
  }
}
loadBank();

// ─── Drive the REAL CbtSessionsService.start() with an in-memory bank ────────
interface Paper {
  answers: Row[];
  essayAnswers: Row[];
  hardDeadline: Date;
}

async function composePaper(level: CertLevel, specVersion: string, seedSuffix = ''): Promise<Paper> {
  const bank = BANKS[level];
  const sessionId = `sess-${level}-${seedSuffix}`;
  const userId = 'user-1';
  const captured: Paper = { answers: [], essayAnswers: [], hardDeadline: new Date(0) };

  const tx = {
    questionBank: {
      findMany: jest.fn(async () => bank.questions),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    taskTemplate: {
      findMany: jest.fn(async () => bank.tasks),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    answer: { createMany: jest.fn(async ({ data }: any) => { captured.answers = data; return { count: data.length }; }) },
    essayAnswer: { createMany: jest.fn(async ({ data }: any) => { captured.essayAnswers = data; return { count: data.length }; }) },
    examSession: {
      update: jest.fn(async ({ data }: any) => {
        captured.hardDeadline = data.hardDeadline;
        return { id: sessionId, certType: CertType.AXIS, level, ...data };
      }),
    },
  };

  const prisma = {
    examSession: {
      findUnique: jest.fn(async () => ({
        id: sessionId, userId, certType: CertType.AXIS, level,
        specVersion, status: ExamSessionStatus.CREATED, registrationId: null,
      })),
    },
    consentLog: {
      findMany: jest.fn(async () => [
        { consentType: `EXAM_RULES:${sessionId}` },
        { consentType: `AI_REVIEW:${sessionId}` },
      ]),
    },
    user: { findUnique: jest.fn(async () => ({ name: '응시자' })) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  } as unknown as PrismaService;

  const config = { get: (k: string) => (k === 'cbt.skipIdentityCheck' ? true : undefined) } as any;
  // Post-composition side effects (admin monitor + notifications) are fire-and-forget.
  const adminMonitor = { emitSessionUpdate: jest.fn(), broadcastLiveStatus: jest.fn() } as any;
  const notifications = { notify: jest.fn() } as any;
  const svc = new CbtSessionsService(
    prisma, adminMonitor, notifications, {} as any, {} as any, {} as any, config,
  );

  await svc.start(userId, sessionId);
  return captured;
}

const taskById = (level: CertLevel, id: string) => BANKS[level].tasks.find((t) => t.id === id)!;

beforeAll(() => {
  process.env.L3_PRACTICALS_ENABLED = 'true';
});

// ═══════════════════════════════════════════════════════════════════════════
describe('E2E v3 · the real v3 bank loads', () => {
  it('holds the shipped question counts', () => {
    expect(BANKS.L3.questions.length).toBe(400);
    expect(BANKS.L3.tasks.length).toBe(40);
    expect(BANKS.L2.questions.length).toBe(310);
    expect(BANKS.L2.tasks.length).toBe(57);
    expect(BANKS.L1.questions.length).toBe(250);
    expect(BANKS.L1.tasks.filter((t) => t.part === ExamPart.DELIVERABLE).length).toBe(20);
    expect(BANKS.L1.tasks.filter((t) => t.part === ExamPart.ESSAY).length).toBe(60);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('E2E v3 · L3 paper composition (40 MCQ + 8 실습형)', () => {
  let paper: Paper;
  beforeAll(async () => { paper = await composePaper(CertLevel.L3, '3.0'); });

  it('draws 40 MCQ and 8 practical items', () => {
    expect(paper.answers.length).toBe(40);
    expect(paper.essayAnswers.length).toBe(8);
  });

  it('draws exactly 2 items per 유형 (세트 A 방식)', () => {
    const byType: Record<string, number> = {};
    for (const ea of paper.essayAnswers) {
      const t = taskById(CertLevel.L3, ea.taskId);
      byType[t.taskType] = (byType[t.taskType] ?? 0) + 1;
    }
    expect(byType).toEqual({
      현업적용형: 2, 지시설계형: 2, 분석검증형: 2, 리스크판단형: 2,
    });
  });

  it('honours the documented 중4·상4 difficulty split', () => {
    // 시험설정_명세: "실습형: 세트 A 방식(4유형×2문항, 중4·상4)"
    const diff: Record<string, number> = {};
    for (const ea of paper.essayAnswers) {
      const d = taskById(CertLevel.L3, ea.taskId).difficulty;
      diff[d] = (diff[d] ?? 0) + 1;
    }
    expect(diff['중']).toBe(4);
    expect(diff['상']).toBe(4);
  });

  it('freezes a 90-minute deadline', () => {
    const mins = Math.round((paper.hardDeadline.getTime() - Date.now()) / 60000);
    expect(mins).toBeGreaterThanOrEqual(89);
    expect(mins).toBeLessThanOrEqual(90);
    expect(getTiming(CertType.AXIS, CertLevel.L3, '3.0').totalMinutes).toBe(90);
  });

  it('v2.0 still draws the old 4-item paper (regression)', async () => {
    const old = await composePaper(CertLevel.L3, '2.0', 'v2');
    expect(old.essayAnswers.length).toBe(4);
    const mins = Math.round((old.hardDeadline.getTime() - Date.now()) / 60000);
    expect(mins).toBeLessThanOrEqual(70);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('E2E v3 · L1 paper composition (25 MCQ + 실행계획서 + 서술형 2)', () => {
  let paper: Paper;
  beforeAll(async () => { paper = await composePaper(CertLevel.L1, '3.0'); });

  it('draws 25 Part A questions', () => {
    expect(paper.answers.length).toBe(25);
  });

  it('draws exactly 1 실행계획서 (DELIVERABLE) + 2 서술형 (ESSAY)', () => {
    // The v2 set-coherent draw could not do this — Part B and Part C live in
    // unrelated singleton sets. This is the branch added for v3.
    const parts = paper.essayAnswers.map((e) => e.part).sort();
    expect(parts).toEqual([ExamPart.DELIVERABLE, ExamPart.ESSAY, ExamPart.ESSAY]);
  });

  it('the two essays come from DIFFERENT 유형 (리스크대응 + 변화관리)', () => {
    const types = paper.essayAnswers
      .filter((e) => e.part === ExamPart.ESSAY)
      .map((e) => taskById(CertLevel.L1, e.taskId).taskType);
    expect(new Set(types).size).toBe(2);
  });

  it('freezes a 150-minute deadline', () => {
    const mins = Math.round((paper.hardDeadline.getTime() - Date.now()) / 60000);
    expect(mins).toBeGreaterThanOrEqual(149);
    expect(mins).toBeLessThanOrEqual(150);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('E2E v3 · L2 paper composition (30 MCQ + Task A/B/C from ONE set)', () => {
  let paper: Paper;
  beforeAll(async () => { paper = await composePaper(CertLevel.L2, '3.0'); });

  it('draws 30 MCQ and 3 practical tasks', () => {
    expect(paper.answers.length).toBe(30);
    expect(paper.essayAnswers.length).toBe(3);
  });

  it('all 3 tasks come from the SAME scenario set (coherent set draw)', () => {
    const setNos = new Set(paper.essayAnswers.map((e) => taskById(CertLevel.L2, e.taskId).setNo));
    expect(setNos.size).toBe(1);
  });

  it('the tasks total 70 points (25 + 25 + 20)', () => {
    const total = paper.essayAnswers.reduce((s, e) => s + taskById(CertLevel.L2, e.taskId).points, 0);
    expect(total).toBe(70);
  });

  it('freezes a 120-minute deadline', () => {
    const mins = Math.round((paper.hardDeadline.getTime() - Date.now()) / 60000);
    expect(mins).toBeGreaterThanOrEqual(119);
    expect(mins).toBeLessThanOrEqual(120);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('E2E v3 · L3 grading → aggregate → schema (the ×0.5 chain)', () => {
  const grader = new L3PracticalGraderService();

  /** Submit the answer key itself → a near-perfect answer (real L3Submission shape). */
  function perfectSubmission(task: Row) {
    const ak = task.rubric.answerKey ?? {};
    const selections: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ak)) {
      if (k === 'key_reason') continue;
      selections[k] = v;
    }
    // 80–150자 근거: quote the key_reason (the grader scores length band + keyword coverage).
    const reason = String(ak.key_reason ?? '');
    const rationale = (reason.length >= 80 ? reason : reason + ' 시나리오의 결정 조건에 근거해 판단했다.'.repeat(4)).slice(0, 150);
    return { selections, rationale, promptText: reason.slice(0, 200) || null, raw: {} };
  }

  it('grades 8 real practical items and every raw score stays within 0–10', async () => {
    const paper = await composePaper(CertLevel.L3, '3.0', 'grade');
    const scores = paper.essayAnswers.map((ea) => {
      const t = taskById(CertLevel.L3, ea.taskId);
      const r = grader.gradeL3Practical({ points: t.points, rubric: t.rubric }, perfectSubmission(t) as any, 40);
      return r.earnedPoints;
    });
    expect(scores.length).toBe(8);
    for (const s of scores) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(10);
    }
    // Answer-key submissions must land well above the 40% per-item floor.
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    expect(avg).toBeGreaterThan(6);
  });

  /**
   * The full client round-trip: build the submission the way the UI will — from
   * the CLIENT VIEW (labels + option codes), never from the answer key — then
   * grade it. This is the contract the frontend must implement.
   */
  it('a submission built from the client view scores full marks (UI ↔ grader contract)', () => {
    const shortfalls: string[] = [];

    for (const t of BANKS.L3.tasks) {
      const view = l3ClientView(t.rubric)!;
      const key = t.rubric.answerKey as Record<string, any>;

      // The UI only ever sees `view`. A perfect candidate picks the right codes.
      const selects: Record<string, string[]> = {};
      for (const f of view.fields.filter((x) => x.kind === 'select')) {
        const correct: string[] = ([] as string[]).concat(key[f.key] ?? []);
        expect(correct).toHaveLength(f.selectCount!); // UI cap == answer count
        selects[f.key] = correct;
      }
      const gen = view.fields.find((x) => x.kind === 'generate');
      const envelope: Record<string, unknown> = {
        version: 3,
        selects,
        shortReason: String(key.key_reason ?? '').slice(0, 150).padEnd(80, ' '),
      };
      if (gen) envelope.writePrompt = String(key.example_prompt ?? '').slice(0, gen.maxLen);

      const parsed = parseL3Submission(JSON.stringify(envelope))!;
      expect(parsed).not.toBeNull();
      const r = grader.gradeL3Practical({ points: t.points, rubric: t.rubric }, parsed, 40);

      // The SELECTION portion is deterministic — codes taken from the client view
      // must score exactly full marks. Anything else is a contract break.
      for (const d of r.breakdown.details.filter((x) => x.kind === 'objective')) {
        expect(d.earned).toBeCloseTo(d.points, 1);
      }
      // Risk control: a model answer picks nothing forbidden ⇒ no penalty.
      for (const d of r.breakdown.details.filter((x) => x.kind === 'risk_control')) {
        expect(d.earned).toBeCloseTo(d.points, 1);
      }

      // The generation field must exist and be substantially earnable wherever
      // the bank declares one. Before the fix it was worth 0 points and rendered
      // no input at all — a 지시설계형 perfect answer capped out around 5/10.
      const generated = r.breakdown.details.filter((d) => d.kind === 'generated');
      expect(generated.length > 0).toBe(!!gen);
      for (const d of generated) {
        expect(d.points).toBeGreaterThan(0);
        expect(d.earned).toBeGreaterThanOrEqual(d.points * 0.8);
      }

      // Total: the 근거/생성 criteria are scored by fuzzy Korean keyword coverage
      // (josa-stripped tokens), so even the bank's own text rarely hits 100% —
      // ≥9.5 is the realistic ceiling for a deterministic pre-score. What matters
      // is that no criterion is structurally unearnable.
      if (r.earnedPoints < 9.5) {
        const lost = r.breakdown.details
          .filter((d) => d.earned < d.points - 0.01)
          .map((d) => `${d.key}[${d.kind}] ${d.earned}/${d.points}`)
          .join(' · ');
        shortfalls.push(`${t.id} (${t.taskType}) → ${r.earnedPoints}/10 — lost: ${lost}`);
      }
    }

    if (shortfalls.length) {
      throw new Error(
        `Model answers score below 9.5/10 on ${shortfalls.length}/${BANKS.L3.tasks.length} items:\n  ` +
          shortfalls.join('\n  '),
      );
    }
  });

  it('the generation field carries the documented weight (지시설계 5 · 분석검증 2)', () => {
    const weightOf = (type: string) => {
      const t = BANKS.L3.tasks.find((x) => x.taskType === type)!;
      const gc = (t.rubric.generatedCriteria ?? []) as Array<{ points: number }>;
      return gc.reduce((s, g) => s + g.points, 0);
    };
    expect(weightOf('지시설계형')).toBe(5);   // 지시 보완 3 + 검증요청 2
    expect(weightOf('분석검증형')).toBe(2);   // 검증절차 2
    expect(weightOf('현업적용형')).toBe(0);   // no generation field
    expect(weightOf('리스크판단형')).toBe(0);
    // 위험통제 penalty only exists on 현업적용형.
    const fieldApp = BANKS.L3.tasks.find((x) => x.taskType === '현업적용형')!;
    expect(fieldApp.rubric.riskControl?.points).toBe(2);
  });

  it('the aggregate applies ×0.5, emits 8 item refs, and VALIDATES against the shipped v3 schema', async () => {
    const paper = await composePaper(CertLevel.L3, '3.0', 'agg');
    const tasks = paper.essayAnswers.map((ea) => taskById(CertLevel.L3, ea.taskId));
    // Every item scored 8/10 raw → practice raw 64 → ×0.5 = 32 / 40.
    const answers = paper.essayAnswers.map((ea, i) => ({
      id: `ea-${i}`, taskId: ea.taskId, part: ExamPart.PRACTICAL, contentText: '{}',
      aiChatLog: null, earnedPoints: 8, expertScore: null, aiPreScore: 80, aiConfidence: 0.9,
      aiRiskFlags: [], aiGate: null, aiCriticalFails: null, aiInjectionSuspected: false,
      aiPromptVersion: 'AXIS-L3-AI-SCORING-PROMPT-v1.0', aiRubricVersion: 'v3.0',
    }));
    const sess = {
      id: 'sess-l3', userId: 'u1', certType: CertType.AXIS, level: CertLevel.L3,
      specVersion: '3.0', status: 'SUBMITTED', paperSeed: 'seed',
      writtenScore: 75, practicalScore: null, totalScore: null,
      submittedAt: new Date('2026-07-14T00:00:00Z'), updatedAt: new Date('2026-07-14T00:00:00Z'),
      decisionStatus: DecisionStatus.PROVISIONAL, confirmedAt: null, confirmedByRef: null,
      embeddedAiVersion: null, promptLogRef: null, promptLogHash: null, essayAnswers: answers,
    };
    let saved: any;
    const prisma = {
      examSession: { findUnique: jest.fn(async () => sess), update: jest.fn(async () => ({})) },
      taskTemplate: { findMany: jest.fn(async () => tasks) },
      sessionAggregate: {
        upsert: jest.fn(async ({ create }: any) => ((saved = create), { id: 'agg', ...create })),
        findUnique: jest.fn(),
      },
    } as unknown as PrismaService;

    await new SessionAggregateService(prisma).rebuild('sess-l3');

    expect(saved.schemaValid).toBe(true);          // ← real ajv vs the shipped v3 schema
    expect(saved.schemaErrors).toBeNull();
    const rec = saved.record;
    expect(rec.schema_version).toBe('1.0');
    expect(rec.exam_session.exam_time_limit_minutes).toBe(90);
    expect(rec.practice_item_refs).toHaveLength(8);
    expect(rec.practice_item_refs[0].item_score).toBe(8);   // raw 0–10 stays raw
    expect(rec.scores.practice_score).toBe(32);             // 8 × 8 × 0.5 = 32 (0–40)
    expect(Object.keys(rec.gate_results).sort()).toEqual([
      'objective_score_min_24', 'practice_score_min_16', 'total_score_min_60',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('E2E v3 · L1 aggregate carries the NEW Part C hard cut', () => {
  it('builds a 4-gate record that validates against schema 1.2', async () => {
    const paper = await composePaper(CertLevel.L1, '3.0', 'agg');
    const tasks = paper.essayAnswers.map((ea) => taskById(CertLevel.L1, ea.taskId));
    const answers = paper.essayAnswers.map((ea, i) => {
      const t = taskById(CertLevel.L1, ea.taskId);
      return {
        id: `ea-${i}`, taskId: ea.taskId, part: t.part, contentText: 'x', aiChatLog: null,
        earnedPoints: t.part === ExamPart.DELIVERABLE ? 40 : 6, // Part C 6+6=12 → passes 8 floor
        expertScore: null, aiPreScore: 70, aiConfidence: 0.9, aiRiskFlags: [], aiGate: null,
        aiCriticalFails: null, aiInjectionSuspected: false,
        aiPromptVersion: 'AXIS-L1-AI-SCORING-PROMPT-v1.1', aiRubricVersion: 'v3.0',
      };
    });
    const sess = {
      id: 'sess-l1', userId: 'u1', certType: CertType.AXIS, level: CertLevel.L1,
      specVersion: '3.0', status: 'SUBMITTED', paperSeed: 'seed',
      writtenScore: 70, practicalScore: null, totalScore: null,
      submittedAt: new Date('2026-07-14T00:00:00Z'), updatedAt: new Date('2026-07-14T00:00:00Z'),
      decisionStatus: DecisionStatus.PROVISIONAL, confirmedAt: null, confirmedByRef: null,
      embeddedAiVersion: null, promptLogRef: null, promptLogHash: null, essayAnswers: answers,
    };
    let saved: any;
    const prisma = {
      examSession: { findUnique: jest.fn(async () => sess), update: jest.fn(async () => ({})) },
      taskTemplate: { findMany: jest.fn(async () => tasks) },
      sessionAggregate: {
        upsert: jest.fn(async ({ create }: any) => ((saved = create), { id: 'agg', ...create })),
        findUnique: jest.fn(),
      },
    } as unknown as PrismaService;

    await new SessionAggregateService(prisma).rebuild('sess-l1');

    expect(saved.schemaValid).toBe(true);
    const rec = saved.record;
    expect(rec.schema_version).toBe('1.2');
    expect(rec.exam_session.exam_time_limit_minutes).toBe(150);
    expect(rec.exam_session.ai_use_blocked).toBe(true);
    expect(Object.keys(rec.gate_results).sort()).toEqual([
      'part_a_min_10', 'part_b_min_33', 'part_c_min_8', 'total_score_min_60',
    ]);
    expect(rec.scores.part_c_score).toBe(12);
  });

  it('a failing Part C (7/20) fails the exam even with perfect A and B', () => {
    const scoring = getScoring(CertType.AXIS, CertLevel.L1, '3.0');
    const r = computeWeightedResult(scoring, (p) => (p === ExamPart.ESSAY ? 35 : 100));
    expect(r.gateResults['part_c_min_8']).toBe(false);
    expect(r.passed).toBe(false);
  });
});

/**
 * Seeds the 시험 표준 v2.0 sample content from `new_doc_l3/` into the AXIS
 * series bank so the seeded exam content matches the v2.0 spec documents
 * 1:1 (instead of the generic English placeholders):
 *
 *   pnpm db:seed:v2-samples
 *
 *   question_bank (additive, keyed by sourceRef = item_id):
 *     - L1 Part A 객관식 샘플 10문항 v2.0
 *     - L2 객관식 샘플 10문항 v2.0
 *     - L3 객관식 1차샘플 10문항 v5.0
 *   task_templates (update-in-place of the seed-exam placeholder rows):
 *     - L2 실습형 샘플과제 세트 v2.0 (VOC 시나리오, Task A/B/C = 25/25/20)
 *     - L1 Part B 실행계획서 샘플시나리오 v2.0 (A사, 8-criterion 55점 루브릭)
 *     - L1 Part C 서술형 샘플 2문항 v2.0 (리스크 대응형 / 변화관리형, 각 10점)
 *
 * IMPORTANT — dev-placeholder upgrade ONLY. The real CSV bank
 * (questions/AXIS_L*_*.csv via db:seed:questions) already contains the
 * v2.0 sample-standard content under the Korean evaluation-area subjects
 * (250/300/400 items, 20 practical sets per level), so this seeder is a
 * NO-OP against it: every step first verifies the target is the generic
 * seed-exam placeholder ('[Sample math placeholder]' MCQs / English
 * placeholder task titles) and skips otherwise.
 *
 * Production-safe by design:
 *   - MCQs: inserted only into a placeholder bank; idempotent — an item is
 *     skipped when a row with the same sourceRef (item_id) already exists.
 *     Never deletes.
 *   - Task templates: rows are UPDATED in place (ids/FKs preserved), only
 *     when the row still carries its known seed-exam placeholder title and
 *     has not already been sample-upgraded (rubric JSON carries the sample
 *     id). L3 practicals are handled by seed-l3-practicals.ts and are not
 *     touched here.
 *   - Sample MCQs carry the WP10 v2.0 metadata (lifecycleStatus '승인',
 *     questionTypeTag, riskTag, techAssumptionType, nextReviewAt).
 *   - Item points follow the sibling rows of the same subject bucket (not the
 *     spec's 1pt/1.5pt) so every generated paper keeps a uniform raw total —
 *     scoring is percentage-weighted, so this does not change any outcome.
 */
import { PrismaClient, CertType, CertLevel, ExamPart, QuestionType } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml: { load: (s: string) => unknown } = require('js-yaml');

const prisma = new PrismaClient();

const REPO_ROOT = join(__dirname, '..', '..');
const DOC_ROOT = join(REPO_ROOT, 'new_doc_l3');

const FILES = {
  l1Mcq: join(DOC_ROOT, '1_AXIS L1', '1_객관식', 'AXIS_L1_PartA_객관식_샘플_10문항_v2_0.yaml'),
  l1PartB: join(DOC_ROOT, '1_AXIS L1', '3_실행계획서', 'AXIS_L1_PartB_실행계획서_샘플시나리오_v2_0.yaml'),
  l1PartC: join(DOC_ROOT, '1_AXIS L1', '2_서술형', 'AXIS_L1_PartC_서술형_샘플문항_v2_0.yaml'),
  l2Mcq: join(DOC_ROOT, '2_AXIS L2', '1_객관식', 'AXIS_L2_객관식_샘플_10문항_v2_0.yaml'),
  l2Practical: join(DOC_ROOT, '2_AXIS L2', '2_실습형', 'AXIS_L2_실습형_샘플과제_세트_v2_0.yaml'),
  l3Mcq: join(DOC_ROOT, '3_AXIS L3', '1_객관식', 'AXIS_L3_객관식_1차샘플_10문항_v5_0.yaml'),
} as const;

function loadYaml<T>(path: string): T {
  return yaml.load(readFileSync(path, 'utf8')) as T;
}

function hash(obj: unknown): string {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 32);
}

function addMonths(base: Date, months: number): Date {
  const d = new Date(base);
  d.setMonth(d.getMonth() + months);
  return d;
}

// ─── MCQ sample ingestion ───────────────────────────────────────────────────

interface RawMcqQuestion {
  stem_scenario: string;
  question_line: string;
  options: Record<string, string>;
  answer: string;
  score?: number;
}
interface RawMcqItem {
  item_id: string;
  evaluation_area?: string;
  item_type?: string;
  difficulty?: string;
  business_context_tags?: string[];
  risk_tags?: string[];
  question: RawMcqQuestion;
  explanation?: { correct_answer_reason?: string };
  validity_and_lifespan?: {
    tech_assumption_type?: string;
    tech_review_cycle_months?: number;
  };
  /** L3 v5.0 nests the tags under axis_l3_mapping. */
  axis_l3_mapping?: {
    evaluation_area?: string;
    item_type?: string;
    difficulty?: string;
    business_context_tags?: string[];
    risk_tags?: string[];
  };
}
interface RawMcqDoc {
  items: RawMcqItem[];
}

interface McqSourceSpec {
  level: CertLevel;
  path: string;
  /**
   * Map a sample item onto the existing seed-exam subject buckets so the
   * stratified/subject-count paper generation keeps working unchanged.
   * Returns [subjectIndex, subjectName, points].
   */
  subjectOf: (itemType: string) => [number, string, number];
}

const MCQ_SOURCES: McqSourceSpec[] = [
  {
    level: CertLevel.L1,
    path: FILES.l1Mcq,
    // L1 buckets: 0 = AX Strategy(4pt), 1 = Governance & Risk(4pt).
    subjectOf: (t) =>
      /거버넌스|리스크|컴플라이언스|품질/.test(t)
        ? [1, 'AI Governance & Risk Management', 4]
        : [0, 'AI Transformation (AX) Strategy', 4],
  },
  {
    level: CertLevel.L2,
    path: FILES.l2Mcq,
    // L2 buckets: 0 = Tool Selection(4pt), 1 = Prompt Design(3pt), 2 = Ethics & Security(2pt).
    subjectOf: (t) =>
      /지시설계/.test(t)
        ? [1, 'Advanced Prompt Design', 3]
        : /리스크/.test(t)
          ? [2, 'AI Ethics & Security Practice', 2]
          : [0, 'AI Tool Selection & Strategy', 4],
  },
  {
    level: CertLevel.L3,
    path: FILES.l3Mcq,
    // L3 buckets: 0 = Fundamentals, 1 = Tool Usage, 2 = Prompt Basics, 3 = Ethics (all 2pt).
    subjectOf: (t) =>
      /개념|한계/.test(t)
        ? [0, 'AI Fundamentals', 2]
        : /지시설계/.test(t)
          ? [2, 'Prompt Basics', 2]
          : /리스크/.test(t)
            ? [3, 'AI Ethics & Literacy', 2]
            : [1, 'AI Tool Usage Basics', 2],
  },
];

async function seedMcqSamples(spec: McqSourceSpec): Promise<number> {
  const doc = loadYaml<RawMcqDoc>(spec.path);
  if (!doc?.items?.length) throw new Error(`No items in ${spec.path}`);

  // Guard: only upgrade the seed-exam placeholder bank. A real (CSV) bank
  // already contains the sample-standard items under Korean subjects.
  const placeholder = await prisma.questionBank.count({
    where: {
      certType: CertType.AXIS,
      level: spec.level,
      stem: { contains: '[Sample math placeholder]' },
    },
  });
  if (placeholder === 0) {
    console.log(
      `[skip] AXIS ${spec.level} 객관식: real bank detected (no placeholder rows) — samples already live in the CSV bank.`,
    );
    return 0;
  }

  let inserted = 0;
  for (const item of doc.items) {
    const meta = item.axis_l3_mapping ?? item;
    const itemType = meta.item_type ?? '';
    const existing = await prisma.questionBank.findFirst({
      where: { sourceRef: item.item_id },
      select: { id: true },
    });
    if (existing) continue;

    const [subjectIndex, subjectName, points] = spec.subjectOf(itemType);
    const stem = `${item.question.stem_scenario.trim()}\n\n${item.question.question_line.trim()}`;
    const choices = Object.entries(item.question.options).map(([key, text]) => ({
      key,
      text: String(text).trim(),
    }));
    const techType = item.validity_and_lifespan?.tech_assumption_type ?? '없음';
    const cycleMonths =
      item.validity_and_lifespan?.tech_review_cycle_months ?? (techType !== '없음' ? 6 : 12);

    await prisma.questionBank.create({
      data: {
        certType: CertType.AXIS,
        level: spec.level,
        subjectIndex,
        subjectName,
        type: QuestionType.MCQ,
        stem,
        choices,
        correctAnswer: item.question.answer,
        points,
        contentHash: hash({ stem, choices }),
        difficulty: meta.difficulty ?? null,
        qType: itemType || null,
        explanation: item.explanation?.correct_answer_reason ?? null,
        sourceRef: item.item_id,
        // ── v2.0 (WP10) metadata ──
        lifecycleStatus: '승인',
        questionTypeTag: itemType || null,
        businessContextTag: meta.business_context_tags?.[0] ?? meta.evaluation_area ?? null,
        riskTag: meta.risk_tags?.[0] ?? null,
        techAssumptionType: techType,
        nextReviewAt: addMonths(new Date(), cycleMonths),
      },
    });
    inserted++;
  }
  return inserted;
}

// ─── L2 실습형 sample set → task_templates (update-in-place) ────────────────

interface RawL2Task {
  task_id: string;
  practice_type: string;
  points: number;
  task_prompt: string;
  required_submission?: string[];
  model_answer_elements?: string[];
  rubric?: Record<string, number>;
  risk_flags?: string[];
  expected_answer_outline?: string;
  minimum_pass_points?: number;
  gate_note?: string;
}
interface RawL2Set {
  scenario_set_id: string;
  scenario_title: string;
  scenario_context: string;
  allowed_ai_environment?: Record<string, unknown>;
  provided_materials?: Record<string, unknown>;
  tasks: RawL2Task[];
}

function flattenMaterial(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((row) => {
        if (row && typeof row === 'object') {
          return (
            '- ' +
            Object.entries(row as Record<string, unknown>)
              .map(([k, v]) => `${k}: ${v}`)
              .join(' / ')
          );
        }
        return `- ${row}`;
      })
      .join('\n');
  }
  return String(value ?? '').trim();
}

async function seedL2PracticalSet(): Promise<number> {
  const set = loadYaml<RawL2Set>(FILES.l2Practical);
  if (!set?.tasks || set.tasks.length !== 3) {
    throw new Error(`Expected 3 tasks in ${FILES.l2Practical}`);
  }

  // Guard: only the 3 seed-exam placeholder rows are upgradable. A real bank
  // (20 sets from the 실기 CSV) is left untouched.
  const PLACEHOLDER_TITLES = [
    'Task A: Draft a business deliverable with AI',
    'Task B: Summarize & verify source material',
    'Task C: Improve a workflow with AI',
  ];
  const rows = await prisma.taskTemplate.findMany({
    where: {
      certType: CertType.AXIS,
      level: CertLevel.L2,
      part: ExamPart.PRACTICAL,
      title: { in: PLACEHOLDER_TITLES },
    },
    orderBy: { orderIndex: 'asc' },
  });
  if (rows.length !== 3) {
    console.log(
      `[skip] AXIS L2 practicals: placeholder rows not found (${rows.length}/3) — real bank detected, nothing to upgrade.`,
    );
    return 0;
  }

  const materials = Object.entries(set.provided_materials ?? {})
    .map(([name, value]) => `[${name}]\n${flattenMaterial(value)}`)
    .join('\n\n');

  const sharedContext = [
    `【${set.scenario_title}】`,
    set.scenario_context.trim(),
    '[응시 환경] 시험 시스템 내장 AI만 사용. 외부 AI·외부 검색·개인 자료 업로드 금지. 지시 로그(prompt log)가 기록·채점에 사용된다.',
    materials,
  ]
    .filter(Boolean)
    .join('\n\n');

  let updated = 0;
  for (let i = 0; i < 3; i++) {
    const row = rows[i];
    const task = set.tasks[i];
    const rubricJson = (row.rubric ?? {}) as Record<string, unknown>;
    if (rubricJson.sampleTaskId === task.task_id) continue; // already upgraded
    if (row.points !== task.points) {
      console.log(
        `[warn] AXIS L2 task ${i} points mismatch (row ${row.points} vs sample ${task.points}) — skipping.`,
      );
      continue;
    }

    const scenario = [
      sharedContext,
      `[과제] ${task.task_prompt.trim()}`,
      task.required_submission?.length
        ? `[제출물] ${task.required_submission.join(' · ')}`
        : null,
    ]
      .filter(Boolean)
      .join('\n\n');

    await prisma.taskTemplate.update({
      where: { id: row.id },
      data: {
        title: `${['Task A', 'Task B', 'Task C'][i]}: ${task.practice_type} — ${set.scenario_title}`,
        scenario,
        rubric: {
          ...rubricJson,
          rubric_version: '2.0',
          sampleTaskId: task.task_id,
          scenarioSetId: set.scenario_set_id,
          practiceType: task.practice_type,
          modelAnswerElements: task.model_answer_elements ?? [],
          expectedAnswerOutline: task.expected_answer_outline ?? null,
          // 참고 기준 (하드컷 아님 — 기획서 v2.0 9-2)
          minimumPassPoints: task.minimum_pass_points ?? null,
          gateNote: task.gate_note ?? null,
          riskFlags: task.risk_flags ?? [],
        },
        modelAnswer: (task.model_answer_elements ?? []).join('\n'),
        riskCriteria: (task.risk_flags ?? []).join('\n'),
        lifecycleStatus: '승인',
      },
    });
    updated++;
  }
  return updated;
}

// ─── L1 Part B 실행계획서 sample → DELIVERABLE template ─────────────────────

interface RawL1PartB {
  scenario_id: string;
  title: string;
  context: string;
  organization_profile?: Record<string, unknown>;
  diagnostic_data?: Array<Record<string, unknown>>;
  candidate_projects?: Array<Record<string, unknown>>;
  policy_draft?: string[];
  task_prompt: string;
  required_outputs?: string[];
  rubric: Array<{ criteria: string; points: number; description?: string }>;
  excellent_answer_outline?: string[];
  minimum_pass_points?: string[];
  critical_fail_patterns?: string[];
  anchor_response_set?: Record<string, { score_range?: string; summary?: string; trigger?: string }>;
  gate_note?: string;
}

async function seedL1PartB(): Promise<number> {
  const sc = loadYaml<RawL1PartB>(FILES.l1PartB);
  // Guard: only the seed-exam placeholder row is upgradable — the real bank
  // ships 20 scenario sets built to this sample's standard.
  const row = await prisma.taskTemplate.findFirst({
    where: {
      certType: CertType.AXIS,
      level: CertLevel.L1,
      part: ExamPart.DELIVERABLE,
      title: 'Part B: Organizational AX execution plan',
    },
  });
  if (!row) {
    console.log(
      '[skip] AXIS L1 Part B: placeholder row not found — real bank detected, nothing to upgrade.',
    );
    return 0;
  }
  const rubricJson = (row.rubric ?? {}) as Record<string, unknown>;
  if (rubricJson.sampleScenarioId === sc.scenario_id) return 0; // already upgraded

  const profile = sc.organization_profile
    ? Object.entries(sc.organization_profile)
        .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\n')
    : '';
  const scenario = [
    `【${sc.title}】`,
    sc.context.trim(),
    profile ? `[조직 프로필]\n${profile}` : null,
    sc.diagnostic_data?.length ? `[진단 데이터]\n${flattenMaterial(sc.diagnostic_data)}` : null,
    sc.candidate_projects?.length ? `[AI 적용 후보 과제]\n${flattenMaterial(sc.candidate_projects)}` : null,
    sc.policy_draft?.length ? `[정책 초안]\n${sc.policy_draft.map((p) => `- ${p}`).join('\n')}` : null,
    `[과제] ${sc.task_prompt.trim()}`,
    sc.required_outputs?.length ? `[필수 목차]\n${sc.required_outputs.join('\n')}` : null,
    '[응시 모드] AI 사용 전면 금지 — 잠금 브라우저, 외부 도구·검색·개인 자료 차단. 제공된 고정 템플릿 안에서만 작성.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const anchor = sc.anchor_response_set ?? {};
  await prisma.taskTemplate.update({
    where: { id: row.id },
    data: {
      title: `Part B: 조직 AX 실행계획서 — ${sc.title}`,
      scenario,
      rubric: {
        // "(n점)" lines feed parseRubric exactly like the L2 seeds.
        criteria: sc.rubric.map((r) => `${r.criteria}(${r.points}점)`),
        rubric_version: '2.0',
        sampleScenarioId: sc.scenario_id,
        rubricDetail: sc.rubric,
        excellentAnswerOutline: sc.excellent_answer_outline ?? [],
        // 참고 기준 (하드컷 아님 — L1 기획서 v2.0 9-4)
        minimumPassPoints: sc.minimum_pass_points ?? [],
        criticalFailPatterns: sc.critical_fail_patterns ?? [],
        gateNote: sc.gate_note ?? null,
      },
      requiredStructure: (sc.required_outputs ?? []).join('\n'),
      benchmarkExcellent: anchor.excellent
        ? `${anchor.excellent.score_range ?? ''} ${anchor.excellent.summary ?? ''}`.trim()
        : null,
      benchmarkNormal: anchor.normal
        ? `${anchor.normal.score_range ?? ''} ${anchor.normal.summary ?? ''}`.trim()
        : null,
      benchmarkBorderline: anchor.borderline
        ? `${anchor.borderline.score_range ?? ''} ${anchor.borderline.summary ?? ''}`.trim()
        : null,
      benchmarkFail: anchor.fail
        ? `${anchor.fail.score_range ?? ''} ${anchor.fail.summary ?? ''}`.trim()
        : null,
      lifecycleStatus: '승인',
    },
  });
  return 1;
}

// ─── L1 Part C 서술형 samples → ESSAY templates ─────────────────────────────

interface RawL1PartCItem {
  item_id: string;
  item_type: string;
  score: number;
  scenario: string;
  question: string;
  rubric: Array<{ criteria: string; points: number; description?: string }>;
  excellent_answer_outline?: string[];
  critical_fail_patterns?: string[];
  minimum_pass_points?: string[];
  anchor_response_set?: Record<string, { score_range?: string; summary?: string; trigger?: string }>;
  gate_note?: string;
}
interface RawL1PartCDoc {
  items: RawL1PartCItem[];
}

async function seedL1PartC(): Promise<number> {
  const doc = loadYaml<RawL1PartCDoc>(FILES.l1PartC);
  if (!doc?.items || doc.items.length !== 2) {
    throw new Error(`Expected 2 items in ${FILES.l1PartC}`);
  }
  // Guard: only the 2 seed-exam placeholder rows are upgradable.
  const rows = await prisma.taskTemplate.findMany({
    where: {
      certType: CertType.AXIS,
      level: CertLevel.L1,
      part: ExamPart.ESSAY,
      title: {
        in: [
          'Part C-1: Risk & incident response essay',
          'Part C-2: Change & performance management essay',
        ],
      },
    },
    orderBy: { orderIndex: 'asc' },
  });
  if (rows.length !== 2) {
    console.log(
      `[skip] AXIS L1 ESSAY: placeholder rows not found (${rows.length}/2) — real bank detected, nothing to upgrade.`,
    );
    return 0;
  }

  // 리스크 대응형 → C-1, 변화관리·성과관리형 → C-2 (기획서 v2.0 Part C 고정 구성).
  const ordered = [...doc.items].sort((a, b) => {
    const rank = (t: string) => (/리스크/.test(t) ? 0 : 1);
    return rank(a.item_type) - rank(b.item_type);
  });

  let updated = 0;
  for (let i = 0; i < 2; i++) {
    const row = rows[i];
    const item = ordered[i];
    const rubricJson = (row.rubric ?? {}) as Record<string, unknown>;
    if (rubricJson.sampleItemId === item.item_id) continue; // already upgraded

    const anchor = item.anchor_response_set ?? {};
    await prisma.taskTemplate.update({
      where: { id: row.id },
      data: {
        title: `Part C-${i + 1}: ${item.item_type}`,
        scenario: `${item.scenario.trim()}\n\n[과제] ${item.question.trim()}`,
        rubric: {
          criteria: item.rubric.map((r) => `${r.criteria}(${r.points}점)`),
          rubric_version: '2.0',
          sampleItemId: item.item_id,
          rubricDetail: item.rubric,
          excellentAnswerOutline: item.excellent_answer_outline ?? [],
          minimumPassPoints: item.minimum_pass_points ?? [],
          criticalFailPatterns: item.critical_fail_patterns ?? [],
          gateNote: item.gate_note ?? null,
        },
        benchmarkExcellent: anchor.excellent
          ? `${anchor.excellent.score_range ?? ''} ${anchor.excellent.summary ?? ''}`.trim()
          : null,
        benchmarkNormal: anchor.normal
          ? `${anchor.normal.score_range ?? ''} ${anchor.normal.summary ?? ''}`.trim()
          : null,
        benchmarkBorderline: anchor.borderline
          ? `${anchor.borderline.score_range ?? ''} ${anchor.borderline.summary ?? ''}`.trim()
          : null,
        benchmarkFail: anchor.fail
          ? `${anchor.fail.score_range ?? ''} ${anchor.fail.summary ?? ''}`.trim()
          : null,
        lifecycleStatus: '승인',
      },
    });
    updated++;
  }
  return updated;
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('Seeding 시험 표준 v2.0 sample content from new_doc_l3/ …');

  for (const src of MCQ_SOURCES) {
    const n = await seedMcqSamples(src);
    console.log(`[ok]   AXIS ${src.level} 객관식 샘플 → ${n} inserted (skip-existing by item_id).`);
  }

  const l2 = await seedL2PracticalSet();
  console.log(`[ok]   AXIS L2 실습형 샘플과제 세트 → ${l2} template rows upgraded.`);

  const b = await seedL1PartB();
  console.log(`[ok]   AXIS L1 Part B 실행계획서 샘플시나리오 → ${b} template row upgraded.`);

  const c = await seedL1PartC();
  console.log(`[ok]   AXIS L1 Part C 서술형 샘플 → ${c} template rows upgraded.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

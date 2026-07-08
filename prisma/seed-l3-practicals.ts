/**
 * Seeds the 4 L3 실습형 (practical) TaskTemplate rows per AXIS series.
 *
 *   pnpm db:seed:l3-practicals
 *
 * 시험 표준 v2.0 (WP9): the AXIS series seeds from the re-authored v2.0 sample
 * set (new_doc_l3 — 근거 2점 고정, 게이트, 오답 의무화, 부분점수) and carries
 * the per-criterion splits (`fieldPoints` / `riskControl` /
 * `generatedCriteria` / `mustNotChoose`, rubric_version '2.0') that the
 * deterministic grader consumes. AXIS-C / AXIS-H stay on their v1.1 sample
 * sets until v2.0 sets are authored — the grader falls back to the legacy
 * even split for those rows.
 *
 * Production-safe by design:
 *   - Idempotent: skips a (certType, L3) pair if any L3 TaskTemplate row already
 *     exists for it. Never overwrites, never deletes.
 *   - Schema-clean: only inserts into `task_templates`; no new columns.
 *   - Inserts 4 rows per series (12 total when run on a clean DB), one per
 *     canonical practice type (현업적용·지시설계·분석검증·리스크판단).
 *
 * Activation: after running the seed, flip `L3_PRACTICALS_ENABLED=true` on the
 * target environment to surface the practicals in the L3 exam and demo. The
 * flag is read at request time, so no restart is required — but in-flight L3
 * sessions are still unaffected because their paper was frozen on `start`.
 *
 * Source files (paths relative to repo root):
 *   new_doc_l3/3_AXIS L3/2_실습형/AXIS_L3_실습형_샘플문항_세트_v2_0.yaml (AXIS)
 *   exam questions/new_files_check/3_AXIS_시리즈_출제/3_AXIS-C/3_AXIS-C_ L3/AXIS-C_L3_실습형_출제자료_패키지/AXIS-C_L3_실습형_샘플문항_세트_v1_1.yaml
 *   exam questions/new_files_check/3_AXIS_시리즈_출제/2_AXIS-H/3_AXIS-H_ L3/AXIS-H_L3_실습형_출제자료_패키지/AXIS-H_L3_실습형_샘플문항_세트_v1_1.yaml
 */
import { PrismaClient, CertType, CertLevel, ExamPart } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';
// js-yaml ships as CJS without bundled types in this repo; require it dynamically
// to avoid pulling in @types/js-yaml as a new direct dependency.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml: { load: (s: string) => unknown } = require('js-yaml');

const prisma = new PrismaClient();

const REPO_ROOT = join(__dirname, '..', '..');
const SAMPLES_DIR = join(
  REPO_ROOT,
  'exam questions',
  'new_files_check',
  '3_AXIS_시리즈_출제',
);

interface SourceSpec {
  certType: CertType;
  /** Absolute path to the sample-set YAML for this series. */
  path: string;
  /** Rubric standard version stored on the seeded rows. */
  rubricVersion: '1.1' | '2.0';
}

/**
 * 시험 표준 v2.0: the AXIS series ships a re-authored v2.0 sample set
 * (오답 의무화·라벨 중립화·근거 2점·게이트 — new_doc_l3). AXIS-C / AXIS-H
 * v2.0 sets are not yet authored, so those series stay on their v1.1 samples
 * (the grader keys per-criterion scoring off the rubric wrapper, so mixed
 * versions coexist safely).
 */
const V2_SAMPLES_PATH = join(
  REPO_ROOT,
  'new_doc_l3',
  '3_AXIS L3',
  '2_실습형',
  'AXIS_L3_실습형_샘플문항_세트_v2_0.yaml',
);

const SOURCES: SourceSpec[] = [
  {
    certType: CertType.AXIS,
    path: V2_SAMPLES_PATH,
    rubricVersion: '2.0',
  },
  {
    certType: CertType.AXIS_C,
    path: join(
      SAMPLES_DIR,
      '3_AXIS-C',
      '3_AXIS-C_ L3',
      'AXIS-C_L3_실습형_출제자료_패키지',
      'AXIS-C_L3_실습형_샘플문항_세트_v1_1.yaml',
    ),
    rubricVersion: '1.1',
  },
  {
    certType: CertType.AXIS_H,
    path: join(
      SAMPLES_DIR,
      '2_AXIS-H',
      '3_AXIS-H_ L3',
      'AXIS-H_L3_실습형_출제자료_패키지',
      'AXIS-H_L3_실습형_샘플문항_세트_v1_1.yaml',
    ),
    rubricVersion: '1.1',
  },
];

/**
 * v2.0 per-criterion splits (루브릭 v2.1 템플릿 / 개발자 명세서 §3-2): the
 * objective answer-key field → criterion points, plus the penalty-based
 * 위험통제 criterion (현업적용형) and the generated-text criteria
 * (지시설계형·분석검증형). Rationale (근거) is fixed at 2 pts in every type
 * and read from the rubric itself.
 */
const V2_FIELD_POINTS: Record<CanonicalType, Record<string, number>> = {
  // 핵심 판단 4 (tasks) / 자료·절차 2 = 금지 자료 1 + 검토 지점 1
  현업적용형: { tasks: 4, excluded_materials: 1, review_point: 1 },
  // 조건 추출·누락요소 식별 3
  지시설계형: { elements: 3 },
  // 문제 식별 4 / 우선수정 2
  분석검증형: { issues: 4, first_action: 2 },
  // 위험 식별 3 / 우선순위·즉시조치 3 / 대응조치 2
  리스크판단형: { highest_risk: 3, immediate_action: 3, alternative: 2 },
};

const V2_RISK_CONTROL: Partial<Record<CanonicalType, { points: number; penaltyPerHit: number }>> = {
  // 위험통제 2점: 기본 2점에서 금지 옵션 선택 1개당 −1 (하한 0, 부록 A)
  현업적용형: { points: 2, penaltyPerHit: 1 },
};

const V2_GENERATED_CRITERIA: Partial<
  Record<CanonicalType, Array<{ label: string; points: number; kind: string }>>
> = {
  지시설계형: [
    { label: '지시 보완', points: 3, kind: 'prompt_quality' },
    { label: '검증요청', points: 2, kind: 'verification_request' },
  ],
  분석검증형: [{ label: '검증절차', points: 2, kind: 'prompt_quality' }],
};

/** Canonical practice types — the spec mandates exactly one per L3 exam set. */
const CANONICAL_TYPES = [
  '현업적용형',
  '지시설계형',
  '분석검증형',
  '리스크판단형',
] as const;
type CanonicalType = (typeof CANONICAL_TYPES)[number];

/**
 * The sample YAMLs ship slightly different `practice_type` labels per series:
 *   AXIS:    "현업적용형" / "지시설계형" / "분석·검증형" / "리스크 판단형"
 *   AXIS-C:  "자동화 현업적용형" / "코드 요청·지시설계형" / "코드 분석·검증형" / "보안·라이선스 리스크형"
 *   AXIS-H:  "현업적용형" / "지시설계형" / "분석·검증형" / "리스크 판단형"
 * Normalize to the 4 canonical type names the runtime stratifier uses.
 */
function normalizePracticeType(raw: string): CanonicalType {
  const s = raw.replace(/[·\s]/g, '');
  if (s.includes('현업적용')) return '현업적용형';
  if (s.includes('지시설계') || s.includes('코드요청')) return '지시설계형';
  if (s.includes('분석') || s.includes('검증')) return '분석검증형';
  if (s.includes('리스크') || s.includes('보안') || s.includes('라이선스')) return '리스크판단형';
  throw new Error(`Unrecognized practice_type: "${raw}"`);
}

interface RawItem {
  practice_item_id?: string;
  item_id?: string;
  practice_type: string;
  scenario?: unknown;
  task?: string;
  task_instruction?: string;
  choices?: Record<string, string>;
  response_format?: unknown;
  answer_key?: unknown;
  rubric?: unknown;
  rubric_10_points?: unknown;
  risk_flags?: unknown;
  expert_review_trigger?: unknown;
  difficulty?: string;
  evaluation_area?: string;
  content_reference?: unknown;
  time_minutes?: number;
  score?: number;
}

interface RawDoc {
  items: RawItem[];
}

/**
 * Flatten a scenario field that can be either a string (AXIS/AXIS-H) or a
 * structured object (AXIS-C) into a single human-readable Korean block.
 */
function flattenScenario(scenario: unknown): string {
  if (typeof scenario === 'string') return scenario.trim();
  if (scenario && typeof scenario === 'object') {
    const s = scenario as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof s.workplace_context === 'string') parts.push(s.workplace_context);
    if (Array.isArray(s.given_materials)) {
      parts.push(...s.given_materials.filter((x): x is string => typeof x === 'string'));
    }
    return parts.join('\n').trim();
  }
  return '';
}

function extractTaskInstruction(item: RawItem): string {
  if (typeof item.task === 'string') return item.task;
  if (typeof item.task_instruction === 'string') return item.task_instruction;
  if (item.scenario && typeof item.scenario === 'object') {
    const s = item.scenario as Record<string, unknown>;
    if (typeof s.task_instruction === 'string') return s.task_instruction;
  }
  return '';
}

interface SeededRow {
  certType: CertType;
  taskType: CanonicalType;
  itemId: string;
}

async function seedSeries(spec: SourceSpec): Promise<SeededRow[]> {
  const existing = await prisma.taskTemplate.count({
    where: { certType: spec.certType, level: CertLevel.L3 },
  });
  if (existing > 0) {
    console.log(
      `[skip] ${spec.certType} L3 already has ${existing} TaskTemplate rows — refusing to insert duplicates.`,
    );
    return [];
  }

  const raw = readFileSync(spec.path, 'utf8');
  const doc = yaml.load(raw) as RawDoc;
  if (!doc?.items || !Array.isArray(doc.items)) {
    throw new Error(`No \`items\` array in ${spec.path}`);
  }

  // Group by normalized type and take the first item per canonical type.
  const byType = new Map<CanonicalType, RawItem>();
  for (const item of doc.items) {
    const t = normalizePracticeType(item.practice_type);
    if (!byType.has(t)) byType.set(t, item);
  }

  const missing = CANONICAL_TYPES.filter((t) => !byType.has(t));
  if (missing.length > 0) {
    throw new Error(
      `${spec.certType} sample set missing canonical types: ${missing.join(', ')}`,
    );
  }

  const seeded: SeededRow[] = [];
  for (let i = 0; i < CANONICAL_TYPES.length; i++) {
    const taskType = CANONICAL_TYPES[i];
    const item = byType.get(taskType)!;
    const itemId = item.practice_item_id ?? item.item_id ?? `${spec.certType}-L3-P-${i + 1}`;
    const scenario = flattenScenario(item.scenario);
    const taskInstruction = extractTaskInstruction(item);
    const composedScenario = [scenario, `[과제] ${taskInstruction}`]
      .filter(Boolean)
      .join('\n\n');

    const title = `[L3 실습 ${i + 1}/4 · ${taskType}] ${
      taskInstruction.length > 50 ? taskInstruction.slice(0, 50) + '…' : taskInstruction || itemId
    }`;

    const rubricPayload: Record<string, unknown> = {
      itemId,
      practiceType: taskType,
      evaluationArea: item.evaluation_area ?? null,
      difficulty: item.difficulty ?? null,
      contentReference: item.content_reference ?? null,
      choices: item.choices ?? null,
      responseFormat: item.response_format ?? null,
      answerKey: item.answer_key ?? null,
      rubric: item.rubric ?? item.rubric_10_points ?? null,
      riskFlags: item.risk_flags ?? null,
      expertReviewTrigger: item.expert_review_trigger ?? null,
      rubric_version: spec.rubricVersion,
    };

    if (spec.rubricVersion === '2.0') {
      // v2.0 answer keys nest the objective fields under `required_choices`
      // ({tasks: [T1,T2], …}); flatten them to the grader's field map and
      // surface the reference prose (key_reason / example prompt) alongside.
      const rawKey = (item.answer_key ?? {}) as Record<string, unknown>;
      const required = (rawKey.required_choices ?? {}) as Record<string, unknown>;
      rubricPayload.answerKey = {
        ...required,
        ...(typeof rawKey.key_reason === 'string' ? { key_reason: rawKey.key_reason } : {}),
        ...(typeof rawKey.example_prompt === 'string'
          ? { example_prompt: rawKey.example_prompt }
          : typeof rawKey.example_revision_prompt === 'string'
            ? { example_prompt: rawKey.example_revision_prompt }
            : {}),
      };
      rubricPayload.mustNotChoose = Array.isArray(rawKey.must_not_choose)
        ? rawKey.must_not_choose
        : [];
      rubricPayload.fieldPoints = V2_FIELD_POINTS[taskType];
      rubricPayload.riskControl = V2_RISK_CONTROL[taskType] ?? null;
      rubricPayload.generatedCriteria = V2_GENERATED_CRITERIA[taskType] ?? null;
      rubricPayload.partialCreditRule = rawKey.partial_credit_rule ?? null;
      rubricPayload.priorityRationale = rawKey.priority_rationale ?? null;
    }

    await prisma.taskTemplate.create({
      data: {
        certType: spec.certType,
        level: CertLevel.L3,
        part: ExamPart.PRACTICAL,
        title,
        scenario: composedScenario,
        rubric: rubricPayload as unknown as object,
        durationMin: 5,
        points: 10,
        orderIndex: i,
        // The L3 spec mandates 1 set/round with stratified picking from the pool.
        // We tag every seeded row with setNo=1 so the existing setNo grouping
        // logic in cbt-sessions still treats them as a coherent set; the new
        // stratifier groups by `taskType` regardless of setNo, so this is
        // forward-compatible if more sets are added later.
        setNo: 1,
        taskType,
        timeLimit: 5,
        maxScore: 10,
      },
    });
    seeded.push({ certType: spec.certType, taskType, itemId });
  }
  console.log(
    `[ok]   ${spec.certType} L3 → seeded ${seeded.length} practical templates ` +
      `(${seeded.map((s) => s.taskType).join(', ')})`,
  );
  return seeded;
}

async function main() {
  console.log('Seeding L3 실습형 (4 practical types) per series…');
  console.log('Source root:', SAMPLES_DIR);
  let total = 0;
  for (const spec of SOURCES) {
    const seeded = await seedSeries(spec);
    total += seeded.length;
  }
  console.log(`\nDone. Inserted ${total} TaskTemplate rows total.`);
  if (total === 0) {
    console.log('(All series already seeded — nothing to do.)');
  } else {
    console.log(
      '\nNext step: set L3_PRACTICALS_ENABLED=true to surface practicals in L3 exam + demo.',
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

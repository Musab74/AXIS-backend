/**
 * Seeds the 4 L3 실습형 (practical) TaskTemplate rows per AXIS series, derived
 * from the v1.1 운영기획서 sample sets in `exam questions/new_files_check/...`.
 *
 *   pnpm db:seed:l3-practicals
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
 *   exam questions/new_files_check/3_AXIS_시리즈_출제/1_AXIS/3_AXIS L3/AXIS_L3_실습형_출제자료_패키지/AXIS_L3_실습형_샘플문항_세트_v1_1.yaml
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
  /** Absolute path to the v1.1 sample-set YAML for this series. */
  path: string;
}

const SOURCES: SourceSpec[] = [
  {
    certType: CertType.AXIS,
    path: join(
      SAMPLES_DIR,
      '1_AXIS',
      '3_AXIS L3',
      'AXIS_L3_실습형_출제자료_패키지',
      'AXIS_L3_실습형_샘플문항_세트_v1_1.yaml',
    ),
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
  },
];

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

    const rubricPayload = {
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
    };

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

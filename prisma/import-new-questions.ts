/**
 * Import authored questions from new_doc_l3/ into question_bank + task_templates.
 *
 *   npm run db:import-new                       # DRY RUN — parse + report, write nothing
 *   npm run db:import-new -- --write            # upsert by item_id (additive, idempotent)
 *   npm run db:import-new -- --replace          # DELETE target banks, then insert fresh
 *   npm run db:import-new -- --series AXIS --level L3 --write
 *   npm run db:import-new -- --lifecycle 초안    # import as draft (default: 승인 = drawable)
 *
 * Reads the *시스템등록용* / bank YAMLs (MCQ, L3 실습형, L1 서술형) plus L2
 * 실습형 세트 docs (scenario_set_id + tasks[] — Task A/B/C share one scenario
 * and are drawn together via a shared setNo), maps the v2.0 metadata
 * (difficulty, type/risk tags, tech-assumption, answer keys, rubrics), and
 * writes them. 구버전 folders are ignored.
 *
 * Precedence & lifecycle:
 *   - Bank folders (평가문항/평가출제) are ingested BEFORE 작성도구 (authoring
 *     tools), so when an item id exists in both, the bank/정합판 version wins.
 *   - MCQs that exist ONLY in 작성도구 files import as 초안 (reference,
 *     non-drawable). Practical sets are exempt: the L2 세트형 sample
 *     (AXIS-L2-PR-SAMPLE-001) is a full member of the 20-set bank.
 *
 * Safety:
 *   - Answer.questionId / EssayAnswer.taskId are NOT foreign keys and every
 *     answered item is frozen as a contentSnapshot on the session, so deleting
 *     bank rows never breaks completed or in-progress exams.
 *   - DRY RUN is the default. --replace deletes ONLY the (series, level) scope
 *     you pass (or everything the files cover) before inserting.
 *   - Idempotent: --write upserts MCQ by sourceRef(item_id); --replace clears
 *     then inserts, so re-running as more content lands is safe.
 */
import { PrismaClient, CertType, CertLevel, ExamPart, QuestionType } from '@prisma/client';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml: { load: (s: string) => unknown } = require('js-yaml');

const prisma = new PrismaClient();
const ROOT = join(__dirname, '..', '..', 'new_doc_l3');

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const WRITE = has('--write');
const REPLACE = has('--replace');
const DRY = !WRITE && !REPLACE;
const LIFECYCLE = val('--lifecycle') ?? '승인'; // only 승인 items are drawable
const ONLY_SERIES = val('--series') as CertType | undefined;
const ONLY_LEVEL = val('--level') as CertLevel | undefined;

// ── helpers ──────────────────────────────────────────────────────────────────
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '구버전' || name === '0_구버전') continue;
    if (name.includes('비편입')) continue; // 예비/비편입 reserve items — not part of the live bank
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.yaml') || p.endsWith('.yml')) out.push(p);
  }
  return out;
}
const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const hash = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 32);

function seriesOf(p: string): CertType {
  if (p.includes('AXIS-H')) return CertType.AXIS_H;
  if (p.includes('AXIS-C')) return CertType.AXIS_C;
  return CertType.AXIS;
}
function levelOf(p: string): CertLevel {
  if (/L1|Leader/.test(p)) return CertLevel.L1;
  if (/L2/.test(p)) return CertLevel.L2;
  return CertLevel.L3;
}
const CANON: Record<string, string> = { '분석·검증형': '분석검증형', '리스크 판단형': '리스크판단형' };
function normType(t: string): string {
  const s = (t ?? '').replace(/[·\s]/g, '');
  if (s.includes('현업적용') || s.includes('자동화현업')) return '현업적용형';
  if (s.includes('지시설계') || s.includes('코드요청')) return '지시설계형';
  if (s.includes('분석') || s.includes('검증') || s.includes('오류')) return '분석검증형';
  if (s.includes('리스크') || s.includes('보안') || s.includes('라이선스')) return '리스크판단형';
  return CANON[t] ?? t;
}

interface Parsed {
  mcq: any[]; // question_bank rows (partial)
  practical: any[]; // task_templates PRACTICAL
  essay: any[]; // task_templates ESSAY
}
const parsed: Parsed = { mcq: [], practical: [], essay: [] };
const seenIds = new Set<string>();

// subjectIndex per (level) assigned deterministically by evaluation_area order.
// L3 is pre-seeded with the canonical ①~⑥ order of the 400문항 통합본/이원목적표 so
// the drawable bank always occupies s0–s5 regardless of file walk order (the
// v5.1 sample uses an old wording for 영역⑥ and would otherwise steal an index).
const subjIndex: Record<string, Map<string, number>> = {
  L3: new Map([
    ['AI 현실 이해와 한계 판단', 0],
    ['업무문제 정의와 AI 적용·도구 선택', 1],
    ['AI 지시·맥락·대화 설계', 2],
    ['AI 산출물 검증과 품질관리', 3],
    ['업무 산출물 수정·적용', 4],
    ['보안·개인정보·저작권·윤리', 5],
  ]),
};
function subjectIndexFor(level: string, area: string): number {
  const m = (subjIndex[level] ??= new Map());
  if (!m.has(area)) m.set(area, m.size);
  return m.get(area)!;
}

function ingestFile(path: string) {
  let doc: any;
  try { doc = yaml.load(readFileSync(path, 'utf8')); } catch { return; }
  const series = seriesOf(path);
  const level = levelOf(path);
  // 작성도구 samples are reference material: bank folders were walked first (see
  // main), so shared ids already deduped to the bank version; MCQs unique to a
  // 작성도구 file land as 초안 (non-drawable).
  const fromAuthoring = path.includes('작성도구');
  if (ONLY_SERIES && series !== ONLY_SERIES) return;
  if (ONLY_LEVEL && level !== ONLY_LEVEL) return;

  // L2 실습형 세트 (scenario_set_id + tasks[]): one shared scenario, Task A/B/C
  // drawn together. 템플릿 files carry task_schema (no tasks[]) and 예시답안
  // files carry answers[] — neither matches, so only real sets ingest.
  if (doc?.scenario_set_id && Array.isArray(doc?.tasks)) {
    ingestPracticalSet(doc, series, level);
    return;
  }

  const items = doc?.items ?? doc?.questions ?? (Array.isArray(doc) ? doc : null);
  if (!Array.isArray(items)) return;

  for (const it of items) {
    if (!rec(it)) continue;
    const id = it.item_id ?? it.practice_item_id ?? null;
    if (id && seenIds.has(id)) continue; // dedupe across files (bank + form reuse)
    if (id) seenIds.add(id);
    const meta = it.axis_l3_mapping ?? it.axis_l2_mapping ?? it.axis_l1_mapping ?? it;

    if (it.practice_type) {
      // ── L3 실습형 practical ──
      const type = normType(it.practice_type);
      const ak = rec(it.answer_key) ?? {};
      const required = rec(ak.required_choices) ?? {};
      parsed.practical.push({
        certType: series, level, part: ExamPart.PRACTICAL,
        title: `[${type}] ${String(it.task ?? id ?? '').slice(0, 50)}`,
        scenario: [flatten(it.scenario), it.task ? `[과제] ${it.task}` : ''].filter(Boolean).join('\n\n'),
        points: Number(it.score) || 10, durationMin: Number(it.time_minutes) || 5,
        taskType: type, difficulty: it.difficulty ?? null, sourceId: id,
        rubric: {
          itemId: id, practiceType: type, evaluationArea: it.evaluation_area ?? null,
          difficulty: it.difficulty ?? null, responseFormat: it.response_format ?? null,
          answerKey: { ...required, ...(typeof ak.key_reason === 'string' ? { key_reason: ak.key_reason } : {}) },
          mustNotChoose: Array.isArray(ak.must_not_choose) ? ak.must_not_choose : [],
          partialCreditRule: ak.partial_credit_rule ?? null,
          rubric: it.rubric_10_points ?? it.rubric ?? null,
          riskFlags: it.risk_flags ?? null, rubric_version: '2.0',
        },
      });
    } else if (it.question && rec(it.question)?.options) {
      // ── MCQ (객관식) ──
      const q = rec(it.question)!;
      const opts = rec(q.options) ?? {};
      const choices = Object.entries(opts).map(([key, text]) => ({ key, text: String(text) }));
      const area = String(meta.evaluation_area ?? it.evaluation_area ?? it.item_type ?? '기타');
      const stem = [q.stem_scenario, q.question_line].filter(Boolean).join('\n\n');
      parsed.mcq.push({
        certType: series, level, subjectIndex: subjectIndexFor(level, area), subjectName: area,
        type: QuestionType.MCQ, stem, choices, correctAnswer: String(q.answer ?? 'A'),
        points: Number(q.score) || 1, contentHash: hash({ stem, choices }),
        difficulty: meta.difficulty ?? it.difficulty ?? null,
        qType: meta.item_type ?? it.item_type ?? null,
        questionTypeTag: meta.item_type ?? it.item_type ?? null,
        businessContextTag: (meta.business_context_tags ?? [])[0] ?? null,
        riskTag: (meta.risk_tags ?? it.risk_tags ?? [])[0] ?? null,
        techAssumptionType: rec(it.validity_and_lifespan)?.tech_assumption_type ?? null,
        explanation: rec(it.explanation)?.correct_answer_reason ?? null,
        sourceRef: id, lifecycleStatus: fromAuthoring ? '초안' : LIFECYCLE,
      });
    } else if (it.rubric && (it.scenario || it.question)) {
      // ── L1 서술형 (Part C essay) ──
      const rubricArr = Array.isArray(it.rubric) ? it.rubric : [];
      parsed.essay.push({
        certType: series, level, part: ExamPart.ESSAY,
        title: `[${it.item_type ?? 'Part C'}] ${String(id ?? '').slice(-8)}`,
        scenario: [it.scenario, it.question ? `[과제] ${it.question}` : ''].filter(Boolean).join('\n\n'),
        points: Number(it.score) || 10, durationMin: 15,
        taskType: it.item_type ?? null, difficulty: it.difficulty ?? null, sourceId: id,
        rubric: {
          itemId: id,
          criteria: rubricArr.map((r: any) => `${r.criteria}(${r.points}점)`),
          rubricDetail: rubricArr, excellentAnswerOutline: it.excellent_answer_outline ?? [],
          criticalFailPatterns: it.critical_fail_patterns ?? [], rubric_version: '2.0',
        },
      });
    }
  }
}
function flatten(s: unknown): string {
  if (typeof s === 'string') return s.trim();
  const r = rec(s);
  if (!r) return '';
  const parts: string[] = [];
  if (typeof r.workplace_context === 'string') parts.push(r.workplace_context);
  if (Array.isArray(r.given_materials)) parts.push(...r.given_materials.filter((x): x is string => typeof x === 'string'));
  return parts.join('\n').trim();
}

// provided_materials values are strings or arrays of row-objects (운영 현황표 etc.).
function flattenMaterial(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((row) => rec(row)
        ? '- ' + Object.entries(row as Record<string, unknown>).map(([k, v]) => `${k}: ${v}`).join(' / ')
        : `- ${row}`)
      .join('\n');
  }
  return String(value ?? '').trim();
}

// L2 실습형 세트 → one practical row per task, same rubric/column shape as
// seed-v2-samples.ts seedL2PracticalSet so parseRubric/parseL3Reference and the
// coherent-set draw (shared setNo, orderIndex = A/B/C position) keep working.
function ingestPracticalSet(doc: any, series: CertType, level: CertLevel) {
  const setId = String(doc.scenario_set_id);
  if (seenIds.has(setId)) return;
  seenIds.add(setId);

  const materials = Object.entries(rec(doc.provided_materials) ?? {})
    .map(([name, value]) => `[${name}]\n${flattenMaterial(value)}`)
    .join('\n\n');
  const sharedContext = [
    doc.scenario_title ? `【${doc.scenario_title}】` : '',
    typeof doc.scenario_context === 'string' ? doc.scenario_context.trim() : '',
    '[응시 환경] 시험 시스템 내장 AI만 사용. 외부 AI·외부 검색·개인 자료 업로드 금지. 지시 로그(prompt log)가 기록·채점에 사용된다.',
    materials,
  ].filter(Boolean).join('\n\n');
  const aiTool = String(rec(doc.allowed_ai_environment)?.tool ?? '시험 시스템 내장 AI');

  (doc.tasks as any[]).forEach((t, i) => {
    if (!rec(t)) return;
    const letter = String.fromCharCode(65 + i); // A, B, C…
    const rubricMap = rec(t.rubric) ?? {};
    parsed.practical.push({
      certType: series, level, part: ExamPart.PRACTICAL,
      title: `Task ${letter}: ${t.practice_type ?? ''} — ${doc.scenario_title ?? setId}`,
      scenario: [
        sharedContext,
        t.task_prompt ? `[과제] ${String(t.task_prompt).trim()}` : '',
        Array.isArray(t.required_submission) && t.required_submission.length
          ? `[제출물] ${t.required_submission.join(' · ')}` : '',
      ].filter(Boolean).join('\n\n'),
      points: Number(t.points) || 20,
      durationMin: parseInt(String(t.time_recommendation ?? ''), 10) || 20,
      taskType: t.practice_type ?? null, difficulty: t.difficulty ?? null,
      sourceId: t.task_id ?? `${setId}-${letter}`,
      aiToolAllowed: aiTool,
      modelAnswer: Array.isArray(t.model_answer_elements) ? t.model_answer_elements.join('\n') : null,
      riskCriteria: Array.isArray(t.risk_flags) ? t.risk_flags.join('\n') : null,
      lifecycleStatus: LIFECYCLE,
      setKey: setId, orderInSet: i,
      rubric: {
        itemId: t.task_id ?? null, scenarioSetId: setId,
        practiceType: t.practice_type ?? null,
        criteria: Object.entries(rubricMap).map(([k, v]) => `${k}(${v}점)`),
        modelAnswerElements: t.model_answer_elements ?? [],
        expectedAnswerOutline: t.expected_answer_outline ?? null,
        // 참고 기준 (하드컷 아님 — 기획서 v2.0 9-2)
        minimumPassPoints: t.minimum_pass_points ?? null,
        gateNote: t.gate_note ?? null,
        riskFlags: t.risk_flags ?? [], rubric_version: '2.0',
      },
    });
  });
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nMode: ${DRY ? 'DRY RUN (no writes)' : REPLACE ? 'REPLACE (delete + insert)' : 'WRITE (upsert)'}` +
    `${ONLY_SERIES ? ` · series=${ONLY_SERIES}` : ''}${ONLY_LEVEL ? ` · level=${ONLY_LEVEL}` : ''} · lifecycle=${LIFECYCLE}\n`);

  // Bank folders first, 작성도구 last — so the 정합판/bank version of an item id
  // wins the first-seen dedupe over its 작성도구 sample twin.
  const files = walk(ROOT).sort((a, b) => {
    const aa = a.includes('작성도구') ? 1 : 0;
    const bb = b.includes('작성도구') ? 1 : 0;
    return aa - bb || a.localeCompare(b);
  });
  for (const f of files) ingestFile(f);

  // report
  const by = (arr: any[], k: (x: any) => string) => arr.reduce<Record<string, number>>((m, x) => ((m[k(x)] = (m[k(x)] || 0) + 1), m), {});
  console.log('Parsed:');
  console.log('  MCQ       :', parsed.mcq.length, JSON.stringify(by(parsed.mcq, (x) => `${x.certType}/${x.level}`)));
  const draftMcq = parsed.mcq.filter((q) => q.lifecycleStatus === '초안').length;
  if (draftMcq) console.log(`              └ ${draftMcq} from 작성도구 samples → 초안 (non-drawable reference)`);
  console.log('  Practical :', parsed.practical.length, JSON.stringify(by(parsed.practical, (x) => `${x.certType}/${x.level}`)));
  console.log('  Essay     :', parsed.essay.length, JSON.stringify(by(parsed.essay, (x) => `${x.certType}/${x.level}`)));

  if (DRY) {
    console.log('\n(DRY RUN — nothing written. Re-run with --write to upsert, or --replace to delete+insert.)');
    return;
  }

  if (REPLACE) {
    const scope: any = {};
    if (ONLY_SERIES) scope.certType = ONLY_SERIES;
    if (ONLY_LEVEL) scope.level = ONLY_LEVEL;
    // delete only the (series×level) combos the files actually cover, unless scoped.
    const combos = new Set([...parsed.mcq, ...parsed.practical, ...parsed.essay].map((x) => `${x.certType}|${x.level}`));
    for (const c of combos) {
      const [certType, level] = c.split('|');
      if (ONLY_SERIES && certType !== ONLY_SERIES) continue;
      if (ONLY_LEVEL && level !== ONLY_LEVEL) continue;
      const dq = await prisma.questionBank.deleteMany({ where: { certType: certType as CertType, level: level as CertLevel } });
      const dt = await prisma.taskTemplate.deleteMany({ where: { certType: certType as CertType, level: level as CertLevel } });
      console.log(`  [replace] cleared ${certType} ${level}: ${dq.count} MCQ, ${dt.count} tasks`);
    }
  }

  // MCQ
  let mAdd = 0, mUpd = 0;
  for (const q of parsed.mcq) {
    const existing = q.sourceRef ? await prisma.questionBank.findFirst({ where: { sourceRef: q.sourceRef }, select: { id: true } }) : null;
    if (existing && !REPLACE) { await prisma.questionBank.update({ where: { id: existing.id }, data: q }); mUpd++; }
    else { await prisma.questionBank.create({ data: q }); mAdd++; }
  }
  // Practical + essay tasks — assign setNo per (certType,level,taskType) for the
  // unique key. Set-based tasks (L2 실습형 세트) instead share ONE setNo per
  // scenario set — the L1/L2 draw groups by setNo to keep Task A/B/C together —
  // with orderIndex = position in the set. Unique key still holds: same setNo,
  // distinct taskType per task.
  const setNo: Record<string, number> = {};
  const setNoByScenarioSet: Record<string, number> = {};
  let tAdd = 0;
  for (const t of [...parsed.practical, ...parsed.essay]) {
    const { sourceId, setKey, orderInSet, ...row } = t;
    let no: number, order: number;
    if (setKey) {
      const grp = `${t.certType}|${t.level}`;
      const sk = `${grp}|${setKey}`;
      if (!(sk in setNoByScenarioSet)) setNoByScenarioSet[sk] = (setNo[grp] = (setNo[grp] ?? 0) + 1);
      no = setNoByScenarioSet[sk];
      order = orderInSet;
    } else {
      const key = `${t.certType}|${t.level}|${t.taskType}`;
      setNo[key] = (setNo[key] ?? 0) + 1;
      no = setNo[key];
      order = no - 1;
    }
    await prisma.taskTemplate.create({ data: { ...row, setNo: no, orderIndex: order, maxScore: row.points, timeLimit: row.durationMin } });
    tAdd++;
  }
  console.log(`\nDone. MCQ: +${mAdd} new, ${mUpd} updated. Tasks: +${tAdd}.`);
  console.log('Reminder: only 승인 lifecycle items are drawable; imported as', LIFECYCLE + '.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());

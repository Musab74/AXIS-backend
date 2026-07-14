/**
 * v3.0 SPEC-CONFORMANCE SMOKE TEST — code vs the shipped documentation.
 *
 * Every expectation here is READ FROM new_version_v3/ at runtime (확정안 YAML +
 * 세션집계 JSON 스키마 + the question banks themselves). Nothing is hand-copied,
 * so if the standard is revised and the code is not, this test fails — and it
 * prints a DOC vs CODE table showing exactly which value drifted.
 *
 *   npm run smoke:v3
 *
 * Requires no database. Sources (relative to repo root):
 *   new_version_v3/3_AXIS L3/…/4_시험·채점_설정/AXIS_L3_시험설정_명세.yaml
 *   new_version_v3/2_AXIS L2/…/4_시험·채점_설정/AXIS_L2_시험설정_명세.yaml
 *   new_version_v3/1_AXIS L1/…/5_시험·채점_설정/AXIS_L1_시험설정_명세.yaml
 *   new_version_v3/{level}/…/채점_세션집계_JSON스키마.json  (L1/L2/L3)
 */
import { CertLevel, CertType, ExamPart } from '@prisma/client';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { getExamSpec, getScoring, getTiming } from './modules/cbtSessions/exam-spec';
import { REVIEW_BANDS_V3, REVIEW_REASONS_V3 } from './modules/grading/review-bands';
import {
  SESSION_AGGREGATE_SCHEMAS_BY_SPEC,
  SESSION_AGGREGATE_SCHEMA_VERSIONS,
} from './modules/grading/session-aggregate-schemas';
import { EXPECTED_MC, EXPECTED_PRACTICAL } from './modules/cbtSessions/bank-expectations';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml: { load: (s: string) => any } = require('js-yaml');

const ROOT = join(__dirname, '..', '..', 'new_version_v3');
const SPEC_YAML: Record<'L1' | 'L2' | 'L3', string> = {
  L1: join(ROOT, '1_AXIS L1/1_시스템업로드·검토용_패키지/5_시험·채점_설정/AXIS_L1_시험설정_명세.yaml'),
  L2: join(ROOT, '2_AXIS L2/1_시스템업로드·검토용_패키지/4_시험·채점_설정/AXIS_L2_시험설정_명세.yaml'),
  L3: join(ROOT, '3_AXIS L3/1_시스템업로드·검토용_패키지/4_시험·채점_설정/AXIS_L3_시험설정_명세.yaml'),
};
const SCHEMA_JSON: Record<'L1' | 'L2' | 'L3', string> = {
  L1: join(ROOT, '1_AXIS L1/1_시스템업로드·검토용_패키지/5_시험·채점_설정/AXIS_L1_채점_세션집계_JSON스키마.json'),
  L2: join(ROOT, '2_AXIS L2/2_AI 채점/3_채점_세션집계_JSON스키마.json'),
  L3: join(ROOT, '3_AXIS L3/2_AI 채점/3_AXIS_L3_채점_세션집계_JSON스키마.json'),
};

// ── harness ──────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures: string[] = [];

function section(t: string) {
  console.log(`\n▶ ${t}`);
}
/** Compare a documented value against the code's value and print both. */
function cmp(what: string, doc: unknown, code: unknown) {
  const ok = JSON.stringify(doc) === JSON.stringify(code);
  const d = typeof doc === 'object' ? JSON.stringify(doc) : String(doc);
  const c = typeof code === 'object' ? JSON.stringify(code) : String(code);
  if (ok) {
    pass++;
    console.log(`   ✅ ${what.padEnd(46)} DOC ${d.padEnd(22)} = CODE ${c}`);
  } else {
    fail++;
    failures.push(`${what}: DOC ${d} ≠ CODE ${c}`);
    console.log(`   ❌ ${what.padEnd(46)} DOC ${d.padEnd(22)} ≠ CODE ${c}`);
  }
}
function check(what: string, ok: boolean, note = '') {
  if (ok) {
    pass++;
    console.log(`   ✅ ${what}${note ? ` — ${note}` : ''}`);
  } else {
    fail++;
    failures.push(what);
    console.log(`   ❌ ${what}${note ? ` — ${note}` : ''}`);
  }
}

// ── doc parsing helpers ──────────────────────────────────────────────────────
const readYaml = (p: string) => yaml.load(readFileSync(p, 'utf8'));
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));

/** "55~64" → {min:55,max:64} */
function band(s: string): { min: number; max: number } | null {
  const m = String(s).match(/(\d+)\s*~\s*(\d+)/);
  return m ? { min: Number(m[1]), max: Number(m[2]) } : null;
}
/** Pull "라벨 NN" out of a prose rule/band line (L3 states cuts as prose). */
function num(prose: string, label: string): number | null {
  const m = String(prose).match(new RegExp(`${label}\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
}
/** Pull "라벨 NN~MM" out of a prose band line. */
function proseBand(prose: string, label: string): { min: number; max: number } | null {
  const m = String(prose).match(new RegExp(`${label}\\s*(\\d+)\\s*~\\s*(\\d+)`));
  return m ? { min: Number(m[1]), max: Number(m[2]) } : null;
}

const docs = {
  L1: readYaml(SPEC_YAML.L1).exam_config,
  L2: readYaml(SPEC_YAML.L2).exam_config,
  L3: readYaml(SPEC_YAML.L3).exam_config,
};
const schemas = { L1: readJson(SCHEMA_JSON.L1), L2: readJson(SCHEMA_JSON.L2), L3: readJson(SCHEMA_JSON.L3) };
const sec = (level: 'L1' | 'L2' | 'L3', id: string) =>
  docs[level].sections.find((s: any) => s.section === id || s.id === id);

process.env.L3_PRACTICALS_ENABLED = 'true';
const V3 = '3.0' as const;

console.log('═'.repeat(78));
console.log('  AXIS v3.0 SPEC CONFORMANCE — code vs new_version_v3 documentation');
console.log('═'.repeat(78));

// ── 1. 검정시간 (total + per-part) ───────────────────────────────────────────
section('1. 검정시간 (시험설정_명세.exam_config.total_time_min)');
{
  for (const lv of ['L3', 'L2', 'L1'] as const) {
    cmp(
      `${lv} 총 검정시간(분)`,
      docs[lv].total_time_min,
      getTiming(CertType.AXIS, CertLevel[lv], V3).totalMinutes,
    );
  }
  // Per-part guides: written = 객관식, practical = the rest.
  const t3 = getTiming(CertType.AXIS, CertLevel.L3, V3);
  cmp('L3 객관식 시간', sec('L3', 'MC').time_guide_min, t3.writtenMinutes);
  cmp('L3 실습형 시간', sec('L3', 'PR').time_guide_min, t3.practicalMinutes);

  const t2 = getTiming(CertType.AXIS, CertLevel.L2, V3);
  cmp('L2 객관식 시간', sec('L2', 'objective').time_min, t2.writtenMinutes);
  cmp(
    'L2 실습 A+B+C 시간',
    sec('L2', 'practice_A').time_min + sec('L2', 'practice_B').time_min + sec('L2', 'practice_C').time_min,
    t2.practicalMinutes,
  );

  const t1 = getTiming(CertType.AXIS, CertLevel.L1, V3);
  cmp('L1 Part A 시간', sec('L1', 'objective').time_min, t1.writtenMinutes);
  cmp(
    'L1 Part B+C 시간',
    sec('L1', 'execution_plan').time_min + sec('L1', 'essay').time_min,
    t1.practicalMinutes,
  );
}

// ── 2. 배점 (section score = weight in the 100-pt model) ─────────────────────
section('2. 배점 (sections[].score → LevelScoring.weight)');
{
  const w = (lv: 'L1' | 'L2' | 'L3', part: ExamPart) =>
    getScoring(CertType.AXIS, CertLevel[lv], V3).sections.find((s) => s.part === part)?.weight;

  cmp('L3 객관식 배점', sec('L3', 'MC').score, w('L3', ExamPart.WRITTEN));
  cmp('L3 실습형 배점', sec('L3', 'PR').score, w('L3', ExamPart.PRACTICAL));
  cmp('L2 객관식 배점', sec('L2', 'objective').score, w('L2', ExamPart.WRITTEN));
  cmp(
    'L2 실습 A+B+C 배점',
    sec('L2', 'practice_A').score + sec('L2', 'practice_B').score + sec('L2', 'practice_C').score,
    w('L2', ExamPart.PRACTICAL),
  );
  cmp('L1 Part A 배점', sec('L1', 'objective').score, w('L1', ExamPart.WRITTEN));
  cmp('L1 Part B 배점', sec('L1', 'execution_plan').score, w('L1', ExamPart.DELIVERABLE));
  cmp('L1 Part C 배점', sec('L1', 'essay').score, w('L1', ExamPart.ESSAY));

  for (const lv of ['L3', 'L2', 'L1'] as const) {
    const total = getScoring(CertType.AXIS, CertLevel[lv], V3).sections.reduce((s, x) => s + x.weight, 0);
    cmp(`${lv} 총점(가중합)`, docs[lv].total_score, total);
  }
}

// ── 3. 출제 문항 수 ──────────────────────────────────────────────────────────
section('3. 출제 문항 수 (sections[].items → LevelExamSpec)');
{
  const spec3 = getExamSpec(CertType.AXIS, CertLevel.L3, V3);
  cmp('L3 객관식 문항 수', sec('L3', 'MC').items, spec3.writtenQuestionCount);
  cmp('L3 실습형 문항 수', sec('L3', 'PR').items, spec3.practicalTaskCount);

  const spec2 = getExamSpec(CertType.AXIS, CertLevel.L2, V3);
  cmp('L2 객관식 문항 수', sec('L2', 'objective').items, spec2.writtenQuestionCount);
  cmp('L2 실습 과제 수 (A/B/C)', 3, spec2.practicalTaskCount);

  const spec1 = getExamSpec(CertType.AXIS, CertLevel.L1, V3);
  cmp('L1 Part A 문항 수', sec('L1', 'objective').items, spec1.writtenQuestionCount);
  cmp(
    'L1 Part B+C 과제 수',
    sec('L1', 'execution_plan').items + sec('L1', 'essay').items,
    spec1.practicalTaskCount,
  );

  // L3 실습형 환산: 8문항 × 10점 원점수 × 0.5 = 40점 (doc: scoring_origin).
  const pr = sec('L3', 'PR');
  check(
    'L3 실습 환산식 (원점수 10 × 0.5 = per_item 5, 합 40)',
    pr.per_item === 5 && pr.items * 10 * 0.5 === pr.score,
    `${pr.items}문항 × 10 × 0.5 = ${pr.items * 10 * 0.5}점 (doc score ${pr.score})`,
  );
}

// ── 4. 하드컷 (pass_rules) ───────────────────────────────────────────────────
section('4. 하드컷 — 비보상 (pass_rules.*_hard_cut → passTotal + floorPct×weight)');
{
  /** Code's floor as a POINT value on the section's own scale. */
  const floorPts = (lv: 'L1' | 'L2' | 'L3', part: ExamPart) => {
    const s = getScoring(CertType.AXIS, CertLevel[lv], V3).sections.find((x) => x.part === part)!;
    return s.floorPct == null ? null : Math.round((s.floorPct / 100) * s.weight);
  };
  const gateKey = (lv: 'L1' | 'L2' | 'L3', part: ExamPart) =>
    getScoring(CertType.AXIS, CertLevel[lv], V3).sections.find((x) => x.part === part)?.gateKey;

  // L3 states its cuts as prose: "총점 60 이상 AND 객관식 24 이상(40%) AND 실습형 16 이상(40%)"
  const r3 = docs.L3.pass_rules.rule as string;
  cmp('L3 총점 하드컷', num(r3, '총점'), getScoring(CertType.AXIS, CertLevel.L3, V3).passTotal);
  cmp('L3 객관식 과락', num(r3, '객관식'), floorPts('L3', ExamPart.WRITTEN));
  cmp('L3 실습형 과락', num(r3, '실습형'), floorPts('L3', ExamPart.PRACTICAL));

  const p2 = docs.L2.pass_rules;
  cmp('L2 총점 하드컷', p2.total_hard_cut, getScoring(CertType.AXIS, CertLevel.L2, V3).passTotal);
  cmp('L2 객관식 과락', p2.objective_hard_cut, floorPts('L2', ExamPart.WRITTEN));
  cmp('L2 실습 과락 (60% 불변)', p2.practice_hard_cut, floorPts('L2', ExamPart.PRACTICAL));

  const p1 = docs.L1.pass_rules;
  cmp('L1 총점 하드컷', p1.total_hard_cut, getScoring(CertType.AXIS, CertLevel.L1, V3).passTotal);
  cmp('L1 Part A 과락', p1.objective_hard_cut, floorPts('L1', ExamPart.WRITTEN));
  cmp('L1 Part B 과락', p1.execution_plan_hard_cut, floorPts('L1', ExamPart.DELIVERABLE));
  cmp('L1 Part C 과락 (v3 신설)', p1.essay_hard_cut, floorPts('L1', ExamPart.ESSAY));

  // Gate key names must ENCODE the documented cut (they are the schema's keys).
  const encodes = (key: string | null | undefined, cut: number | null) =>
    !!key && !!cut && key.endsWith(`_${cut}`);
  check('L3 gate keys encode the doc cuts',
    encodes(getScoring(CertType.AXIS, CertLevel.L3, V3).totalGateKey, num(r3, '총점')) &&
    encodes(gateKey('L3', ExamPart.WRITTEN), num(r3, '객관식')) &&
    encodes(gateKey('L3', ExamPart.PRACTICAL), num(r3, '실습형')),
    `${getScoring(CertType.AXIS, CertLevel.L3, V3).totalGateKey} · ${gateKey('L3', ExamPart.WRITTEN)} · ${gateKey('L3', ExamPart.PRACTICAL)}`);
  check('L2 gate keys encode the doc cuts',
    encodes(gateKey('L2', ExamPart.WRITTEN), p2.objective_hard_cut) &&
    encodes(gateKey('L2', ExamPart.PRACTICAL), p2.practice_hard_cut),
    `${gateKey('L2', ExamPart.WRITTEN)} · ${gateKey('L2', ExamPart.PRACTICAL)}`);
  check('L1 gate keys encode the doc cuts',
    encodes(gateKey('L1', ExamPart.WRITTEN), p1.objective_hard_cut) &&
    encodes(gateKey('L1', ExamPart.DELIVERABLE), p1.execution_plan_hard_cut) &&
    encodes(gateKey('L1', ExamPart.ESSAY), p1.essay_hard_cut),
    `${gateKey('L1', ExamPart.WRITTEN)} · ${gateKey('L1', ExamPart.DELIVERABLE)} · ${gateKey('L1', ExamPart.ESSAY)}`);
}

// ── 5. 경계밴드 (border_bands_expert_review) ─────────────────────────────────
section('5. 경계밴드 (border_bands → REVIEW_BANDS_V3)');
{
  const b3 = docs.L3.pass_rules.boundary_bands as string; // prose
  cmp('L3 총점 밴드', proseBand(b3, '총점'), REVIEW_BANDS_V3.L3.totalBand);
  cmp('L3 객관식 밴드', proseBand(b3, '객관식'), REVIEW_BANDS_V3.L3.objectiveBand);
  cmp('L3 실습형 밴드', proseBand(b3, '실습형'), REVIEW_BANDS_V3.L3.practiceBand);

  const b2 = docs.L2.pass_rules.border_bands_expert_review;
  cmp('L2 총점 밴드', band(b2.total), REVIEW_BANDS_V3.L2.totalBand);
  cmp('L2 객관식 밴드', band(b2.objective), REVIEW_BANDS_V3.L2.objectiveBand);
  cmp('L2 실습형 밴드', band(b2.practice), REVIEW_BANDS_V3.L2.practiceBand);

  const b1 = docs.L1.pass_rules.border_bands_expert_review;
  cmp('L1 총점 밴드', band(b1.total), REVIEW_BANDS_V3.L1.totalBand);
  cmp('L1 Part A 밴드', band(b1.objective), REVIEW_BANDS_V3.L1.partABand);
  cmp('L1 Part B 밴드', band(b1.execution_plan), REVIEW_BANDS_V3.L1.partBBand);
  cmp('L1 Part C 밴드 (v3 신설)', band(b1.essay), REVIEW_BANDS_V3.L1.partCBand);
}

// ── 6. 세션집계 JSON 스키마 ─────────────────────────────────────────────────
section('6. 세션집계 JSON 스키마 (shipped schema ↔ embedded copy ↔ code)');
{
  for (const lv of ['L3', 'L2', 'L1'] as const) {
    const shipped = schemas[lv];
    const embedded: any = (SESSION_AGGREGATE_SCHEMAS_BY_SPEC['3.0'] as any)[lv];

    cmp(
      `${lv} schema_version`,
      shipped.properties.schema_version.const,
      SESSION_AGGREGATE_SCHEMA_VERSIONS['3.0'][lv],
    );
    cmp(
      `${lv} exam_time_limit_minutes (스키마 const)`,
      shipped.properties.exam_session.properties.exam_time_limit_minutes.const,
      getTiming(CertType.AXIS, CertLevel[lv], V3).totalMinutes,
    );
    // The embedded copy must be byte-identical to the shipped document.
    check(
      `${lv} embedded schema == shipped JSON (verbatim)`,
      JSON.stringify(embedded) === JSON.stringify(shipped),
    );
    // gate_results keys == the code's gate keys for that level.
    const scoring = getScoring(CertType.AXIS, CertLevel[lv], V3);
    const codeGates = [
      ...scoring.sections.map((s) => s.gateKey).filter(Boolean),
      scoring.totalGateKey,
    ].sort();
    const docGates = Object.keys(shipped.properties.gate_results.properties).sort();
    cmp(`${lv} gate_results 키 집합`, docGates, codeGates);

    // Every review reason the code can emit must be in the schema enum.
    const allowed: string[] = shipped.properties.review.properties.review_reasons.items.enum;
    const emitted = Object.values(REVIEW_REASONS_V3[lv]) as string[];
    const stray = emitted.filter((r) => !allowed.includes(r));
    check(`${lv} review_reasons ⊆ 스키마 enum`, stray.length === 0, stray.length ? stray.join(' / ') : `${emitted.length}개 사유 모두 유효`);
  }

  // L3: the paper size the schema demands must equal the paper the engine draws.
  cmp(
    'L3 practice_item_refs (스키마 minItems)',
    schemas.L3.properties.practice_item_refs.minItems,
    getExamSpec(CertType.AXIS, CertLevel.L3, V3).practicalTaskCount,
  );
  cmp(
    'L3 practice_score 최대 (스키마 maximum)',
    schemas.L3.properties.scores.properties.practice_score.maximum,
    sec('L3', 'PR').score,
  );
  cmp(
    'L3 item_score 최대 = 루브릭 원점수 10',
    schemas.L3.properties.practice_item_refs.items.properties.item_score.maximum,
    10,
  );
}

// ── 7. 문항은행 실물 vs 코드의 기대 수량 ────────────────────────────────────
section('7. 문항은행 실물 (new_version_v3 YAML) vs validate-questions 기대치');
{
  // Lightweight independent scan of the shipped bank — a second implementation
  // of the importer's classification, so a drift in either side shows up here.
  const SKIP = /기획서|가이드|검토용_HTML|AI ?채점|시험·채점_설정|구버전|비편입/;
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) {
        if (!SKIP.test(n)) walk(p, out);
      } else if (p.endsWith('.yaml') || p.endsWith('.yml')) out.push(p);
    }
    return out;
  };
  const levelOf = (p: string) => (/L1|Leader/.test(p) ? 'L1' : /L2/.test(p) ? 'L2' : 'L3');
  const seen = new Set<string>();
  const count: Record<string, { mcq: number; task: number }> = {
    L1: { mcq: 0, task: 0 }, L2: { mcq: 0, task: 0 }, L3: { mcq: 0, task: 0 },
  };

  for (const f of walk(ROOT)) {
    let doc: any;
    try { doc = yaml.load(readFileSync(f, 'utf8')); } catch { continue; }
    const lv = levelOf(f);
    if (doc?.scenario_set_id && Array.isArray(doc.tasks)) {
      if (seen.has(doc.scenario_set_id)) continue;
      seen.add(doc.scenario_set_id);
      count[lv].task += doc.tasks.length; // L2 실습형 세트 → Task A/B/C
      continue;
    }
    if (doc?.scenario_id && Array.isArray(doc.rubric) && doc.task_prompt) {
      if (seen.has(doc.scenario_id)) continue;
      seen.add(doc.scenario_id);
      count[lv].task += 1; // L1 Part B 실행계획서
      continue;
    }
    const items = doc?.items ?? doc?.questions;
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const id = it?.item_id ?? it?.practice_item_id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      if (it?.practice_type) count[lv].task += 1;          // L3 실습형
      else if (it?.question?.options) count[lv].mcq += 1;   // 객관식
      else if (it?.rubric && (it?.scenario || it?.question)) count[lv].task += 1; // L1 서술형
    }
  }

  for (const lv of ['L3', 'L2', 'L1'] as const) {
    cmp(`${lv} 객관식 은행 실물`, count[lv].mcq, EXPECTED_MC[`AXIS_${lv}`]);
    cmp(`${lv} 과제(실습/서술/계획서) 실물`, count[lv].task, EXPECTED_PRACTICAL[`AXIS_${lv}`]);
  }
  console.log(
    `   ℹ  L1 과제 = Part B 실행계획서 20 + Part C 서술형 60 = ${count.L1.task} (v2 임포터는 Part B를 전량 누락했음)`,
  );
}

// ── result ───────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(78)}`);
console.log(`  RESULT: ${pass} passed · ${fail} failed`);
if (fail) {
  console.log('\n  DRIFT (문서 ≠ 코드):');
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log('═'.repeat(78));
process.exit(fail === 0 ? 0 : 1);

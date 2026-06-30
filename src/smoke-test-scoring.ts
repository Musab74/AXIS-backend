/**
 * AXIS SCORING & EXPERT-SCOPE SMOKE TEST (no DB required)
 *
 *   npm run smoke:scoring
 *
 * Validates the L1/L2 conformance engine against the spec, using the REAL
 * exported functions (getTiming / getExamSpec / getScoring / computeWeightedResult)
 * and the REAL expert-scope resolver (resolveAllowedCertTypes):
 *   1. Per-(certType, level) timing — incl. AXIS-C L2 = 120 min.
 *   2. Exam composition — L1 = 25 MCQ + 3 practical (1 exec-plan + 2 essays),
 *      L2 = 30 MCQ + 3 practical.
 *   3. Weighted 100-pt scoring — L2 MC30+practical70, L1 MC25+execplan55+essay20,
 *      uniform pass 70, with section floors (과락).
 *   4. Pass/fail cases: clean pass, fail-on-total, fail-on-section-floor.
 *   5. Expert queue scoping: admins unrestricted, coding expert only AXIS_C, etc.
 *
 * Pure functions only — safe to run anywhere, no database connection.
 */
import { CertType, CertLevel, ExamPart } from '@prisma/client';
import {
  getTiming,
  getExamSpec,
  getScoring,
  computeWeightedResult,
} from './modules/cbtSessions/exam-spec';
import { resolveAllowedCertTypes } from './modules/grading/admin-grading.service';
import { isExamAiAllowed } from './modules/cbtPractical/cbt-practical.service';
import { evaluatePromptScope, trigramCosine } from './modules/cbtPractical/prompt-scope-guard';

let passCount = 0;
let failCount = 0;

function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    passCount++;
    console.log(`   ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failCount++;
    console.log(`   ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string) {
  console.log(`\n▶ ${title}`);
}

// L3 spec is flag-controlled (운영기획서 v1.1 rollout). The smoke test must
// run under a known flag value to assert deterministically; force it off
// here so we exercise the legacy MCQ-only path as the baseline, then flip
// the flag at the end and re-check the wire-up numbers.
process.env.L3_PRACTICALS_ENABLED = 'false';

// ── 1. Timing (per cert+level) ──────────────────────────────────────────────
section('Timing — keyed by (certType, level) [L3_PRACTICALS_ENABLED=false]');
{
  // L3 — Starter, MCQ only, 60 minutes (no practical) — legacy path.
  const axisL3 = getTiming(CertType.AXIS, CertLevel.L3);
  check('AXIS L3 total = 60', axisL3.totalMinutes === 60, `got ${axisL3.totalMinutes}`);
  check('AXIS L3 written = 60', axisL3.writtenMinutes === 60, `got ${axisL3.writtenMinutes}`);
  check('AXIS L3 practical = 0', axisL3.practicalMinutes === 0, `got ${axisL3.practicalMinutes}`);
  const cL3 = getTiming(CertType.AXIS_C, CertLevel.L3);
  check('AXIS_C L3 total = 60', cL3.totalMinutes === 60, `got ${cL3.totalMinutes}`);
  const hL3 = getTiming(CertType.AXIS_H, CertLevel.L3);
  check('AXIS_H L3 total = 60', hL3.totalMinutes === 60, `got ${hL3.totalMinutes}`);

  const axisL2 = getTiming(CertType.AXIS, CertLevel.L2);
  check('AXIS L2 total = 90', axisL2.totalMinutes === 90, `got ${axisL2.totalMinutes}`);
  const hL2 = getTiming(CertType.AXIS_H, CertLevel.L2);
  check('AXIS_H L2 total = 90', hL2.totalMinutes === 90, `got ${hL2.totalMinutes}`);
  const cL2 = getTiming(CertType.AXIS_C, CertLevel.L2);
  check('AXIS_C L2 total = 120 (override)', cL2.totalMinutes === 120, `got ${cL2.totalMinutes}`);
  check('AXIS_C L2 practical = 90', cL2.practicalMinutes === 90, `got ${cL2.practicalMinutes}`);
  const l1 = getTiming(CertType.AXIS, CertLevel.L1);
  check('L1 total = 120', l1.totalMinutes === 120, `got ${l1.totalMinutes}`);
  check('L1 written = 30', l1.writtenMinutes === 30, `got ${l1.writtenMinutes}`);
  check('L1 practical = 90', l1.practicalMinutes === 90, `got ${l1.practicalMinutes}`);
}

// ── 2. Exam composition ─────────────────────────────────────────────────────
section('Exam composition');
{
  // L3 — 40 MCQ, no practical (spec §5: 객관식 40문항 + 60분).
  const l3 = getExamSpec(CertType.AXIS, CertLevel.L3);
  check('L3 written count = 40', l3.writtenQuestionCount === 40, `got ${l3.writtenQuestionCount}`);
  check('L3 practical tasks = 0', l3.practicalTaskCount === 0, `got ${l3.practicalTaskCount}`);
  const l3DistTotal = Object.values(l3.subjectDistribution ?? {}).reduce((a, b) => a + b, 0);
  check('L3 subject distribution sums to 40', l3DistTotal === 40, `sum=${l3DistTotal}`);

  const l1 = getExamSpec(CertType.AXIS, CertLevel.L1);
  check('L1 written count = 25', l1.writtenQuestionCount === 25, `got ${l1.writtenQuestionCount}`);
  check('L1 practical tasks = 3', l1.practicalTaskCount === 3, `got ${l1.practicalTaskCount}`);
  const l2 = getExamSpec(CertType.AXIS, CertLevel.L2);
  check('L2 written count = 30', l2.writtenQuestionCount === 30, `got ${l2.writtenQuestionCount}`);
  check('L2 practical tasks = 3', l2.practicalTaskCount === 3, `got ${l2.practicalTaskCount}`);
  // getExamSpec carries the cert-specific timing:
  check(
    'AXIS_C L2 spec.timing = 120',
    getExamSpec(CertType.AXIS_C, CertLevel.L2).timing.totalMinutes === 120,
  );
  check(
    'L3 spec.timing = 60 (across all certs)',
    getExamSpec(CertType.AXIS, CertLevel.L3).timing.totalMinutes === 60 &&
      getExamSpec(CertType.AXIS_C, CertLevel.L3).timing.totalMinutes === 60 &&
      getExamSpec(CertType.AXIS_H, CertLevel.L3).timing.totalMinutes === 60,
  );
}

// ── 3. Scoring weights sum to 100 + pass 70 (L1/L2) or 60 (L3) ──────────────
section('Scoring weights');
{
  // L3 is single-section (written-only) with passTotal = 60 per spec §6-1.
  const l3 = getScoring(CertType.AXIS, CertLevel.L3);
  const l3Sum = l3.sections.reduce((a, sec) => a + sec.weight, 0);
  check('L3 weights sum to 100', l3Sum === 100, `got ${l3Sum}`);
  check('L3 pass total = 60', l3.passTotal === 60, `got ${l3.passTotal}`);
  check('L3 single section (WRITTEN)', l3.sections.length === 1 && l3.sections[0].part === ExamPart.WRITTEN);

  for (const lvl of [CertLevel.L1, CertLevel.L2] as const) {
    const s = getScoring(CertType.AXIS, lvl);
    const sum = s.sections.reduce((a, sec) => a + sec.weight, 0);
    check(`${lvl} weights sum to 100`, sum === 100, `got ${sum}`);
    check(`${lvl} pass total = 70`, s.passTotal === 70, `got ${s.passTotal}`);
  }
  const l2 = getScoring(CertType.AXIS, CertLevel.L2);
  const written = l2.sections.find((s) => s.part === ExamPart.WRITTEN)!;
  const practical = l2.sections.find((s) => s.part === ExamPart.PRACTICAL)!;
  check('L2 MC weight 30', written.weight === 30);
  check('L2 practical weight 70', practical.weight === 70);
  check('L2 practical floor 60%', practical.floorPct === 60);
  const l1 = getScoring(CertType.AXIS, CertLevel.L1);
  check('L1 exec-plan weight 55', l1.sections.find((s) => s.part === ExamPart.DELIVERABLE)?.weight === 55);
  check('L1 essay weight 20', l1.sections.find((s) => s.part === ExamPart.ESSAY)?.weight === 20);
}

// ── 4. Weighted pass/fail cases (the real finalize math) ────────────────────
section('Weighted pass/fail (computeWeightedResult)');
{
  // L3 — single WRITTEN section, pass at 60 (auto-graded immediately).
  const l3 = getScoring(CertType.AXIS, CertLevel.L3);
  const l3Pass = computeWeightedResult(l3, () => 75);
  check('L3 written 75% → total 75, pass', l3Pass.total === 75 && l3Pass.passed, `total ${l3Pass.total}`);
  const l3Boundary = computeWeightedResult(l3, () => 60);
  check('L3 written exactly 60% → pass (boundary)', l3Boundary.passed, `total ${l3Boundary.total}`);
  const l3Fail = computeWeightedResult(l3, () => 59);
  check('L3 written 59% → fail (just below)', !l3Fail.passed, `total ${l3Fail.total}`);

  const l2 = getScoring(CertType.AXIS, CertLevel.L2);
  // Clean pass: MC 80%, practical 80% → 0.8*30 + 0.8*70 = 80, both floors ok.
  const r1 = computeWeightedResult(l2, (p) => (p === ExamPart.WRITTEN ? 80 : 80));
  check('L2 80/80 → total 80, pass', r1.total === 80 && r1.passed, `total ${r1.total}`);
  // Fail on total: MC 50%, practical 60% → 0.5*30 + 0.6*70 = 57 (<70). Floors ok.
  const r2 = computeWeightedResult(l2, (p) => (p === ExamPart.WRITTEN ? 50 : 60));
  check('L2 50/60 → total 57, fail (total)', r2.total === 57 && !r2.passed, `total ${r2.total}`);
  // Fail on section floor: MC 100%, practical 50% (<60 floor) → total 65 and floor fail.
  const r3 = computeWeightedResult(l2, (p) => (p === ExamPart.WRITTEN ? 100 : 50));
  check(
    'L2 100/50 → fail on practical floor',
    !r3.passed && r3.floorFailures.includes(ExamPart.PRACTICAL),
    `floors ${r3.floorFailures.join(',') || 'none'}`,
  );

  const l1 = getScoring(CertType.AXIS, CertLevel.L1);
  // L1 pass: MC 80, exec-plan 80, essay 80 → 0.8*100 = 80, floors ok.
  const r4 = computeWeightedResult(l1, () => 80);
  check('L1 80/80/80 → total 80, pass', r4.total === 80 && r4.passed, `total ${r4.total}`);
  // L1 essay below floor (12/20 = 60 floor): essay 50 → floor fail even if total high.
  const r5 = computeWeightedResult(l1, (p) => (p === ExamPart.ESSAY ? 50 : 100));
  check(
    'L1 essay 50% → fail on essay floor',
    !r5.passed && r5.floorFailures.includes(ExamPart.ESSAY),
    `floors ${r5.floorFailures.join(',') || 'none'}`,
  );
}

// ── 5. Expert queue scoping ─────────────────────────────────────────────────
section('Expert queue scoping (resolveAllowedCertTypes)');
{
  check('SUPER_ADMIN → null (all)', resolveAllowedCertTypes(['SUPER_ADMIN'], []) === null);
  check('GRADING_ADMIN → null (all)', resolveAllowedCertTypes(['GRADING_ADMIN'], []) === null);
  const coding = resolveAllowedCertTypes(['EXPERT'], [CertType.AXIS_C]);
  check(
    'EXPERT → null (all series)',
    coding === null,
    JSON.stringify(coding),
  );
  const health = resolveAllowedCertTypes(['EXPERT'], [CertType.AXIS_H]);
  check('EXPERT with AXIS_H competency → still all series', health === null);
  const none = resolveAllowedCertTypes(['EXPERT'], []);
  check('EXPERT with no competency → still all series', none === null);
  // Admin role wins even if EXPERT is also present.
  check(
    'EXPERT+GRADING_ADMIN → null (admin wins)',
    resolveAllowedCertTypes(['EXPERT', 'GRADING_ADMIN'], [CertType.AXIS_C]) === null,
  );
}

// ── 6. In-exam AI gate (only where the task allows it) ──────────────────────
section('In-exam AI gate (isExamAiAllowed)');
{
  check('practical "LMS 내장 AI (ChatGPT/Claude 기반)" → allowed', isExamAiAllowed('LMS 내장 AI (ChatGPT/Claude 기반)'));
  check('coding "LMS 내장 AI 코딩 도구 (Copilot/Cursor 기반)" → allowed', isExamAiAllowed('LMS 내장 AI 코딩 도구 (Copilot/Cursor 기반)'));
  check('L1 exec-plan "LMS 내장 AI" → allowed', isExamAiAllowed('LMS 내장 AI'));
  check('essay "AI 사용 불가" → NOT allowed', !isExamAiAllowed('AI 사용 불가'));
  check('empty → NOT allowed', !isExamAiAllowed(''));
  check('null → NOT allowed', !isExamAiAllowed(null));
  check('"none" → NOT allowed', !isExamAiAllowed('none'));
}

// ── 7. AI prompt scope guard (cross-task paste defense) ─────────────────────
section('AI prompt scope guard (evaluatePromptScope)');
{
  const practicalScope =
    '[과제] AX 실행계획서\n당신은 직원 120명 규모의 중견 제조기업 ㈜가나테크의 경영기획팀장입니다. 대표이사가 생산관리·영업·총무 부서에 AI를 도입하여 업무 효율을 높이라고 지시했습니다.';
  const essaySiblingScope =
    '[문항1] AI 도입 시 보안 관리 핵심 항목 5가지를 서술하시오. [문항2] AI 사용 정책 수립 절차를 설명하시오. [문항3] ROI 산출 시 정량/비정량 지표를 구분하여 서술하시오.';
  const siblings = [
    { taskId: 'task-essay-1', aiAllowed: false, scopeText: essaySiblingScope },
    { taskId: 'task-practical-2', aiAllowed: true, scopeText: '[과제] 제안서 작성\n신규 거래처에 IT 솔루션 도입 제안서를 작성하세요.' },
  ];

  // Normal practical use → ok
  const v1 = evaluatePromptScope(
    '생산관리팀에 어떤 AI 도구가 적합할지 추천해줘',
    practicalScope,
    siblings,
  );
  check('on-topic short prompt → ok', v1.kind === 'ok');

  // Paste of the essay stem → hard reject
  const v2 = evaluatePromptScope(
    essaySiblingScope + ' 답을 작성해줘.',
    practicalScope,
    siblings,
  );
  check(
    'paste of AI-forbidden sibling essay → reject (cross_task_paste_from_ai_forbidden)',
    v2.kind === 'reject' && v2.reason === 'cross_task_paste_from_ai_forbidden',
  );

  // Long unrelated paste → off-topic reject
  const offTopic = '여기 내가 어제 본 영화 리뷰가 있는데 한번 요약해줘 '.repeat(14);
  const v3 = evaluatePromptScope(offTopic, practicalScope, siblings);
  check('long off-topic paste → reject (off_topic_paste)', v3.kind === 'reject' && v3.reason === 'off_topic_paste');

  // Short clarifying question with low overlap → still ok (don't break UX)
  const v4 = evaluatePromptScope('이 문장 다듬어줘', practicalScope, siblings);
  check('short clarifying question with low overlap → ok', v4.kind === 'ok');

  // Trigram sanity
  check('trigramCosine identical strings ≈ 1', trigramCosine('가나다라마바사', '가나다라마바사') > 0.99);
  check('trigramCosine unrelated strings < 0.2', trigramCosine('가나다라마바사', '영화리뷰주말') < 0.2);
}

// ── 8. L3 PRACTICALS WIRE-UP (운영기획서 v1.1) ─────────────────────────────
// Flip the flag and confirm the spec, timing, and scoring all swap atomically.
section('L3 practicals wire-up [L3_PRACTICALS_ENABLED=true]');
{
  process.env.L3_PRACTICALS_ENABLED = 'true';

  // Timing: 60 + 20 = 80 minutes, both written and practical clocks present.
  const t = getTiming(CertType.AXIS, CertLevel.L3);
  check('L3 total = 80 (60 written + 20 practical)', t.totalMinutes === 80, `got ${t.totalMinutes}`);
  check('L3 written = 60', t.writtenMinutes === 60, `got ${t.writtenMinutes}`);
  check('L3 practical = 20', t.practicalMinutes === 20, `got ${t.practicalMinutes}`);

  // Composition: 40 MCQ + 4 practical tasks (one per type, stratified).
  const spec = getExamSpec(CertType.AXIS, CertLevel.L3);
  check('L3 written count = 40', spec.writtenQuestionCount === 40);
  check('L3 practical task count = 4', spec.practicalTaskCount === 4, `got ${spec.practicalTaskCount}`);
  check('L3 spec.timing.totalMinutes = 80', spec.timing.totalMinutes === 80);

  // Scoring: 60-pt written + 40-pt practical, pass 70, practical floor 60%.
  const sc = getScoring(CertType.AXIS, CertLevel.L3);
  const sum = sc.sections.reduce((a, sec) => a + sec.weight, 0);
  check('L3 weights still sum to 100', sum === 100, `got ${sum}`);
  check('L3 passTotal = 70', sc.passTotal === 70, `got ${sc.passTotal}`);
  const written = sc.sections.find((s) => s.part === ExamPart.WRITTEN);
  const practical = sc.sections.find((s) => s.part === ExamPart.PRACTICAL);
  check('L3 written weight = 60', written?.weight === 60, `got ${written?.weight}`);
  check('L3 practical weight = 40', practical?.weight === 40, `got ${practical?.weight}`);
  check('L3 practical floor = 60% (24/40)', practical?.floorPct === 60, `got ${practical?.floorPct}`);
  check('L3 written has NO floor', written?.floorPct === null);

  // computeWeightedResult math: written 80, practical 80 → 0.6*80 + 0.4*80 = 80, pass.
  const r1 = computeWeightedResult(sc, (p) => (p === ExamPart.WRITTEN ? 80 : 80));
  check('L3 80/80 → total 80, pass', r1.total === 80 && r1.passed, `total ${r1.total}`);
  // Boundary at 70: written 80, practical 55 → 0.6*80 + 0.4*55 = 70 — but practical
  // is below the 60% floor, so this should still FAIL on floor (실습형 24점 미만).
  const r2 = computeWeightedResult(sc, (p) => (p === ExamPart.WRITTEN ? 80 : 55));
  check(
    'L3 80/55 → fail on practical floor (24점 미만)',
    !r2.passed && r2.floorFailures.includes(ExamPart.PRACTICAL),
    `floors ${r2.floorFailures.join(',') || 'none'}`,
  );
  // Pass on total + floor: written 60, practical 85 → 0.6*60 + 0.4*85 = 70.
  const r3 = computeWeightedResult(sc, (p) => (p === ExamPart.WRITTEN ? 60 : 85));
  check('L3 60/85 → total 70, pass (boundary)', r3.total === 70 && r3.passed, `total ${r3.total}`);

  // Restore flag so subsequent tooling sees the production default.
  process.env.L3_PRACTICALS_ENABLED = 'false';
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);

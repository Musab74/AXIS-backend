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
import { sessionReviewV2 } from './modules/grading/review-bands';
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
  const axisL3 = getTiming(CertType.AXIS, CertLevel.L3, '1.1');
  check('AXIS L3 total = 60', axisL3.totalMinutes === 60, `got ${axisL3.totalMinutes}`);
  check('AXIS L3 written = 60', axisL3.writtenMinutes === 60, `got ${axisL3.writtenMinutes}`);
  check('AXIS L3 practical = 0', axisL3.practicalMinutes === 0, `got ${axisL3.practicalMinutes}`);
  const cL3 = getTiming(CertType.AXIS_C, CertLevel.L3, '1.1');
  check('AXIS_C L3 total = 60', cL3.totalMinutes === 60, `got ${cL3.totalMinutes}`);
  const hL3 = getTiming(CertType.AXIS_H, CertLevel.L3, '1.1');
  check('AXIS_H L3 total = 60', hL3.totalMinutes === 60, `got ${hL3.totalMinutes}`);

  const axisL2 = getTiming(CertType.AXIS, CertLevel.L2, '1.1');
  check('AXIS L2 total = 90', axisL2.totalMinutes === 90, `got ${axisL2.totalMinutes}`);
  const hL2 = getTiming(CertType.AXIS_H, CertLevel.L2, '1.1');
  check('AXIS_H L2 total = 90', hL2.totalMinutes === 90, `got ${hL2.totalMinutes}`);
  const cL2 = getTiming(CertType.AXIS_C, CertLevel.L2, '1.1');
  check('AXIS_C L2 total = 120 (override)', cL2.totalMinutes === 120, `got ${cL2.totalMinutes}`);
  check('AXIS_C L2 practical = 90', cL2.practicalMinutes === 90, `got ${cL2.practicalMinutes}`);
  const l1 = getTiming(CertType.AXIS, CertLevel.L1, '1.1');
  check('L1 total = 120', l1.totalMinutes === 120, `got ${l1.totalMinutes}`);
  check('L1 written = 30', l1.writtenMinutes === 30, `got ${l1.writtenMinutes}`);
  check('L1 practical = 90', l1.practicalMinutes === 90, `got ${l1.practicalMinutes}`);
}

// ── 2. Exam composition ─────────────────────────────────────────────────────
section('Exam composition');
{
  // L3 — 40 MCQ, no practical (spec §5: 객관식 40문항 + 60분).
  const l3 = getExamSpec(CertType.AXIS, CertLevel.L3, '1.1');
  check('L3 written count = 40', l3.writtenQuestionCount === 40, `got ${l3.writtenQuestionCount}`);
  check('L3 practical tasks = 0', l3.practicalTaskCount === 0, `got ${l3.practicalTaskCount}`);
  const l3DistTotal = Object.values(l3.subjectDistribution ?? {}).reduce((a, b) => a + b, 0);
  check('L3 subject distribution sums to 40', l3DistTotal === 40, `sum=${l3DistTotal}`);

  const l1 = getExamSpec(CertType.AXIS, CertLevel.L1, '1.1');
  check('L1 written count = 25', l1.writtenQuestionCount === 25, `got ${l1.writtenQuestionCount}`);
  check('L1 practical tasks = 3', l1.practicalTaskCount === 3, `got ${l1.practicalTaskCount}`);
  const l2 = getExamSpec(CertType.AXIS, CertLevel.L2, '1.1');
  check('L2 written count = 30', l2.writtenQuestionCount === 30, `got ${l2.writtenQuestionCount}`);
  check('L2 practical tasks = 3', l2.practicalTaskCount === 3, `got ${l2.practicalTaskCount}`);
  // getExamSpec carries the cert-specific timing:
  check(
    'AXIS_C L2 spec.timing = 120',
    getExamSpec(CertType.AXIS_C, CertLevel.L2, '1.1').timing.totalMinutes === 120,
  );
  check(
    'L3 spec.timing = 60 (across all certs)',
    getExamSpec(CertType.AXIS, CertLevel.L3, '1.1').timing.totalMinutes === 60 &&
      getExamSpec(CertType.AXIS_C, CertLevel.L3, '1.1').timing.totalMinutes === 60 &&
      getExamSpec(CertType.AXIS_H, CertLevel.L3, '1.1').timing.totalMinutes === 60,
  );
}

// ── 3. Scoring weights sum to 100 + pass 70 (L1/L2) or 60 (L3) ──────────────
section('Scoring weights');
{
  // L3 is single-section (written-only) with passTotal = 60 per spec §6-1.
  const l3 = getScoring(CertType.AXIS, CertLevel.L3, '1.1');
  const l3Sum = l3.sections.reduce((a, sec) => a + sec.weight, 0);
  check('L3 weights sum to 100', l3Sum === 100, `got ${l3Sum}`);
  check('L3 pass total = 60', l3.passTotal === 60, `got ${l3.passTotal}`);
  check('L3 single section (WRITTEN)', l3.sections.length === 1 && l3.sections[0].part === ExamPart.WRITTEN);

  for (const lvl of [CertLevel.L1, CertLevel.L2] as const) {
    const s = getScoring(CertType.AXIS, lvl, '1.1');
    const sum = s.sections.reduce((a, sec) => a + sec.weight, 0);
    check(`${lvl} weights sum to 100`, sum === 100, `got ${sum}`);
    check(`${lvl} pass total = 70`, s.passTotal === 70, `got ${s.passTotal}`);
  }
  const l2 = getScoring(CertType.AXIS, CertLevel.L2, '1.1');
  const written = l2.sections.find((s) => s.part === ExamPart.WRITTEN)!;
  const practical = l2.sections.find((s) => s.part === ExamPart.PRACTICAL)!;
  check('L2 MC weight 30', written.weight === 30);
  check('L2 practical weight 70', practical.weight === 70);
  check('L2 practical floor 60%', practical.floorPct === 60);
  const l1 = getScoring(CertType.AXIS, CertLevel.L1, '1.1');
  check('L1 exec-plan weight 55', l1.sections.find((s) => s.part === ExamPart.DELIVERABLE)?.weight === 55);
  check('L1 essay weight 20', l1.sections.find((s) => s.part === ExamPart.ESSAY)?.weight === 20);
}

// ── 4. Weighted pass/fail cases (the real finalize math) ────────────────────
section('Weighted pass/fail (computeWeightedResult)');
{
  // L3 — single WRITTEN section, pass at 60 (auto-graded immediately).
  const l3 = getScoring(CertType.AXIS, CertLevel.L3, '1.1');
  const l3Pass = computeWeightedResult(l3, () => 75);
  check('L3 written 75% → total 75, pass', l3Pass.total === 75 && l3Pass.passed, `total ${l3Pass.total}`);
  const l3Boundary = computeWeightedResult(l3, () => 60);
  check('L3 written exactly 60% → pass (boundary)', l3Boundary.passed, `total ${l3Boundary.total}`);
  const l3Fail = computeWeightedResult(l3, () => 59);
  check('L3 written 59% → fail (just below)', !l3Fail.passed, `total ${l3Fail.total}`);

  const l2 = getScoring(CertType.AXIS, CertLevel.L2, '1.1');
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

  const l1 = getScoring(CertType.AXIS, CertLevel.L1, '1.1');
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
// Competency-scoped experts (EXPERT_CERT_SCOPES) see only their series; an
// expert with NO declared competency keeps full access (safe unset default).
section('Expert queue scoping (resolveAllowedCertTypes)');
{
  check('SUPER_ADMIN → null (all)', resolveAllowedCertTypes(['SUPER_ADMIN'], []) === null);
  check('GRADING_ADMIN → null (all)', resolveAllowedCertTypes(['GRADING_ADMIN'], []) === null);
  const coding = resolveAllowedCertTypes(['EXPERT'], [CertType.AXIS_C]);
  check(
    'EXPERT with AXIS_C competency → [AXIS_C] only',
    coding !== null && coding.length === 1 && coding[0] === CertType.AXIS_C,
    JSON.stringify(coding),
  );
  const health = resolveAllowedCertTypes(['EXPERT'], [CertType.AXIS_H]);
  check(
    'EXPERT with AXIS_H competency → [AXIS_H] only',
    health !== null && health.length === 1 && health[0] === CertType.AXIS_H,
    JSON.stringify(health),
  );
  const none = resolveAllowedCertTypes(['EXPERT'], []);
  check('EXPERT with no declared competency → all series (unset default)', none === null);
  const other = resolveAllowedCertTypes(['EXAMINEE'], []);
  check('non-grading role → [] (sees nothing)', other !== null && other.length === 0);
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

  // Timing: 40 written + 20 practical = 60 minutes (운영기획서).
  const t = getTiming(CertType.AXIS, CertLevel.L3, '1.1');
  check('L3 total = 60 (40 written + 20 practical)', t.totalMinutes === 60, `got ${t.totalMinutes}`);
  check('L3 written = 40', t.writtenMinutes === 40, `got ${t.writtenMinutes}`);
  check('L3 practical = 20', t.practicalMinutes === 20, `got ${t.practicalMinutes}`);

  // Composition: 40 MCQ + 4 practical tasks (one per type, stratified).
  const spec = getExamSpec(CertType.AXIS, CertLevel.L3, '1.1');
  check('L3 written count = 40', spec.writtenQuestionCount === 40);
  check('L3 practical task count = 4', spec.practicalTaskCount === 4, `got ${spec.practicalTaskCount}`);
  check('L3 spec.timing.totalMinutes = 60', spec.timing.totalMinutes === 60);

  // Scoring: 60-pt written + 40-pt practical, pass 70, practical floor 60%.
  const sc = getScoring(CertType.AXIS, CertLevel.L3, '1.1');
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

// ── 9. L3 AUTO-FINALIZE ON SUBMIT (운영기획서 §10) ───────────────────────────
// When AI prescore returns mandatoryReview=false AND every practical task is
// scored, the submit path GRADES the L3 session in-request using the same
// weighted-100 math the finalize path uses. Verify that math + the gate.
section('L3 auto-finalize on submit [L3_PRACTICALS_ENABLED=true]');
{
  process.env.L3_PRACTICALS_ENABLED = 'true';
  const scoring = getScoring(CertType.AXIS, CertLevel.L3, '1.1');

  // Prescored L3: written 80% (weight 60) + practical 85% (weight 40), AI confident.
  const writtenPct = 80;
  const practicalPct = 85;
  const r = computeWeightedResult(scoring, (p) => (p === ExamPart.WRITTEN ? writtenPct : practicalPct));
  check('L3 80/85 → weighted total 82', r.total === 82, `total ${r.total}`); // 0.6*80 + 0.4*85
  check('L3 80/85 → pass (≥70, practical ≥60 floor)', r.passed);

  // Gate: auto-finalize (→ GRADED) only when mandatoryReview=false AND all scored.
  const wouldAutoFinalize = (mandatoryReview: boolean, allScored: boolean) =>
    mandatoryReview === false && allScored;
  check('mandatoryReview=false + all scored → auto-finalize (GRADED)', wouldAutoFinalize(false, true));
  check('mandatoryReview=true → defer to expert queue (SUBMITTED)', !wouldAutoFinalize(true, true));
  check('a task unscored → defer to expert queue (SUBMITTED)', !wouldAutoFinalize(false, false));

  // Practical below the 60% floor fails even with a perfect written score.
  const rFloor = computeWeightedResult(scoring, (p) => (p === ExamPart.WRITTEN ? 100 : 55));
  check(
    'L3 100/55 → fail on practical floor (실습형 24점 미만)',
    !rFloor.passed && rFloor.floorFailures.includes(ExamPart.PRACTICAL),
    `floors ${rFloor.floorFailures.join(',') || 'none'}`,
  );

  process.env.L3_PRACTICALS_ENABLED = 'false';
}

// ── 10. 시험 표준 v2.0 (specVersion '2.0') ───────────────────────────────────
// v2.0 rules key off the SESSION's spec version: L3 70분(객관식 50+실습 20),
// 이중 최저기준 하드컷(게이트 키), 명시적 경계밴드. v1.1 assertions above must
// stay green — in-flight sessions keep old behavior.
section('시험 표준 v2.0 — timing 70min + hard cuts + review bands');
{
  process.env.L3_PRACTICALS_ENABLED = 'true';

  const t2 = getTiming(CertType.AXIS, CertLevel.L3, '2.0');
  check('v2.0 L3 total = 70', t2.totalMinutes === 70, `got ${t2.totalMinutes}`);
  check('v2.0 L3 written = 50', t2.writtenMinutes === 50, `got ${t2.writtenMinutes}`);
  check('v2.0 L3 practical = 20', t2.practicalMinutes === 20, `got ${t2.practicalMinutes}`);
  const t1 = getTiming(CertType.AXIS, CertLevel.L3, '1.1');
  check('v1.1 L3 total stays 60', t1.totalMinutes === 60, `got ${t1.totalMinutes}`);
  check('v2.0 L2/L1 timing unchanged',
    getTiming(CertType.AXIS, CertLevel.L2, '2.0').totalMinutes === 90 &&
      getTiming(CertType.AXIS, CertLevel.L1, '2.0').totalMinutes === 120);
  check('v2.0 AXIS_C L2 override still 120',
    getTiming(CertType.AXIS_C, CertLevel.L2, '2.0').totalMinutes === 120);

  // Legacy MCQ-only mode is deprecated but keeps 60 min even under v2.0.
  process.env.L3_PRACTICALS_ENABLED = 'false';
  const tLegacy = getTiming(CertType.AXIS, CertLevel.L3, '2.0');
  check('v2.0 legacy MCQ-only L3 stays 60', tLegacy.totalMinutes === 60, `got ${tLegacy.totalMinutes}`);
  process.env.L3_PRACTICALS_ENABLED = 'true';

  // L3 hard cuts: total ≥70, MCQ ≥30/60 (50%), practical ≥24/40 (60%).
  const l3 = getScoring(CertType.AXIS, CertLevel.L3, '2.0');
  check('v2.0 L3 written floor 50% (30/60 신설)',
    l3.sections.find((s) => s.part === ExamPart.WRITTEN)?.floorPct === 50);
  // Acceptance case: total clears 70 but MCQ misses its 30/60 hard cut → fail
  // with objective_score_min_30=false. (An integer MCQ 29/60 caps the total at
  // 69, so the closest realizable case is written 49.5% = 29.7/60 + practical
  // 40/40 → total 70 rounded.)
  const l3McqFail = computeWeightedResult(l3, (p) => (p === ExamPart.WRITTEN ? 49.5 : 100));
  check(
    'v2.0 L3 total 70 + MCQ 29.7/60 → fail, objective_score_min_30=false',
    !l3McqFail.passed &&
      l3McqFail.total === 70 &&
      l3McqFail.gateResults['objective_score_min_30'] === false &&
      l3McqFail.gateResults['total_score_min_70'] === true &&
      l3McqFail.failedGates.includes('objective_score_min_30'),
    `total ${l3McqFail.total}, gates ${JSON.stringify(l3McqFail.gateResults)}`,
  );
  const l3Clean = computeWeightedResult(l3, () => 80);
  check('v2.0 L3 80/80 → pass, all 3 gates true',
    l3Clean.passed &&
      l3Clean.gateResults['total_score_min_70'] === true &&
      l3Clean.gateResults['objective_score_min_30'] === true &&
      l3Clean.gateResults['practice_score_min_24'] === true);

  // L2 gates carry the schema keys.
  const l2 = getScoring(CertType.AXIS, CertLevel.L2, '2.0');
  const l2Fail = computeWeightedResult(l2, (p) => (p === ExamPart.WRITTEN ? 40 : 90));
  check('v2.0 L2 MCQ 12/30 → objective_score_min_15=false',
    !l2Fail.passed && l2Fail.gateResults['objective_score_min_15'] === false);

  // L1: Part A 13/25 floor 신설, Part C floor REMOVED (review-trigger only).
  const l1 = getScoring(CertType.AXIS, CertLevel.L1, '2.0');
  check('v2.0 L1 essay(Part C) has NO floor',
    l1.sections.find((s) => s.part === ExamPart.ESSAY)?.floorPct === null);
  // Acceptance case: total 71 + Part C 10/20 → PASS (no Part C hard cut).
  const l1PartCLow = computeWeightedResult(l1, (p) =>
    p === ExamPart.ESSAY ? 50 : p === ExamPart.WRITTEN ? 76 : 76.3636,
  ); // 25*0.76 + 55*0.763636 + 20*0.5 = 19 + 42 + 10 = 71
  check(
    'v2.0 L1 total 71 + Part C 10 → PASS (Part C 하드컷 제거)',
    l1PartCLow.passed && l1PartCLow.total === 71,
    `total ${l1PartCLow.total}, floors ${l1PartCLow.floorFailures.join(',') || 'none'}`,
  );
  const l1PartALow = computeWeightedResult(l1, (p) => (p === ExamPart.WRITTEN ? 48 : 100));
  check('v2.0 L1 Part A 12/25 → part_a_min_13=false',
    !l1PartALow.passed && l1PartALow.gateResults['part_a_min_13'] === false);

  // v1.1 L1 keeps the essay floor (regression: old sessions unchanged).
  const l1V11 = getScoring(CertType.AXIS, CertLevel.L1, '1.1');
  check('v1.1 L1 essay floor still 60%',
    l1V11.sections.find((s) => s.part === ExamPart.ESSAY)?.floorPct === 60);
  check('v1.1 gateResults empty (no gate keys)',
    Object.keys(computeWeightedResult(l1V11, () => 80).gateResults).length === 0);

  process.env.L3_PRACTICALS_ENABLED = 'false';
}

// ── 11. v2.0 경계밴드/검수 트리거 (review-bands) ─────────────────────────────
section('v2.0 review bands (sessionReviewV2)');
{
  // L3: total 65–74 boundary + practical band + risk-type low score.
  const l3Band = sessionReviewV2(CertLevel.L3, { total: 72, objective: 45, practice: 27 });
  check('L3 total 72 → 총점 경계권(65~74)',
    l3Band.humanReviewRequired && l3Band.reviewReasons.includes('총점 경계권(65~74)'));
  const l3Practice = sessionReviewV2(CertLevel.L3, { total: 80, objective: 55, practice: 25 });
  check('L3 practical 25 → 실습형 경계밴드(22~26)',
    l3Practice.reviewReasons.includes('실습형 경계밴드(22~26)'));
  const l3Risk = sessionReviewV2(CertLevel.L3, {
    total: 80, objective: 50, practice: 30,
    taskScores: [{ key: 't4', score: 5, max: 10, isRiskJudgementType: true }],
  });
  check('L3 리스크 판단형 5점 → 리스크 판단형 5점 이하',
    l3Risk.reviewReasons.includes('리스크 판단형 5점 이하'));
  const l3McqCut = sessionReviewV2(CertLevel.L3, { total: 75, objective: 29, practice: 39 });
  check('L3 MCQ 29 → 객관식 최저기준 미달(30 미만)',
    l3McqCut.reviewReasons.includes('객관식 최저기준 미달(30 미만)'));
  const l3Clean2 = sessionReviewV2(CertLevel.L3, { total: 85, objective: 50, practice: 35 });
  check('L3 clean 85 → no review', !l3Clean2.humanReviewRequired);

  // L2: MCQ band 13–17, practical band 38–45, single-task <40%.
  const l2Band = sessionReviewV2(CertLevel.L2, { total: 80, objective: 16, practice: 60 });
  check('L2 MCQ 16 → 객관식 경계밴드(13~17)',
    l2Band.reviewReasons.includes('객관식 경계밴드(13~17)'));
  const l2Task = sessionReviewV2(CertLevel.L2, {
    total: 80, objective: 25, practice: 55,
    taskScores: [
      { key: 'task_A', score: 9, max: 25 },
      { key: 'task_B', score: 20, max: 25 },
      { key: 'task_C', score: 8, max: 20 },
    ],
  });
  check('L2 task A 9/25 (<40%) → 단일 과제 40% 미만 + task flagged',
    l2Task.reviewReasons.includes('단일 과제 40% 미만') &&
      l2Task.tasksBelow40Pct.includes('task_A') &&
      !l2Task.tasksBelow40Pct.includes('task_C'), // 8/20 = 40% is NOT below
    JSON.stringify(l2Task.tasksBelow40Pct));

  // L1: Part bands + Part C < 12 review-only trigger (internal reason).
  const l1Bands = sessionReviewV2(CertLevel.L1, { total: 80, objective: 14, practice: 33 });
  check('L1 Part A 14 → Part A 경계밴드(11~15)',
    l1Bands.reviewReasons.includes('Part A 경계밴드(11~15)'));
  check('L1 Part B 33 → Part B 경계밴드(30~36)',
    l1Bands.reviewReasons.includes('Part B 경계밴드(30~36)'));
  // Acceptance case: total 71 + Part C 10 → PASS but human_review_required=true.
  const l1PartC = sessionReviewV2(CertLevel.L1, { total: 80, objective: 20, practice: 45, partC: 10 });
  check('L1 Part C 10 → review via official "Part C 검수 기준(12 미만)" (v1.1)',
    l1PartC.humanReviewRequired &&
      l1PartC.reviewReasons.includes('Part C 검수 기준(12 미만)'),
    JSON.stringify(l1PartC.reviewReasons));
  const l1Clean = sessionReviewV2(CertLevel.L1, { total: 85, objective: 20, practice: 45, partC: 15 });
  check('L1 clean → no review', !l1Clean.humanReviewRequired);
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);

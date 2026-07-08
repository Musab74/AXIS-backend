/**
 * AXIS ALL-IN-ONE SMOKE TEST
 *
 *   npm run smoke:all
 *
 * One entrypoint that verifies (1) the AI provider keys are live and (2) the
 * full L3/L2/L1 grading pipeline behaves — end to end, through the REAL services,
 * with no database writes:
 *   - AI keys: Anthropic (grading + in-exam assistant), Gemini (proctor vision),
 *     Upstage (document parsing) — presence + live auth probes where cheap.
 *   - Rubric parsing (L3 실습형 wrapper → weighted criteria; answer-free reference).
 *   - L3 answer-key grader (objective + rationale, risk flags, expert-review triggers).
 *   - Structured submission envelope parsing ({version, selects, shortReason}).
 *   - Paper client-view (answer-free spec; answerKey NEVER leaked to the client).
 *   - Grading dispatcher routing (planGrading) + weighted-100 pass math + hybrid merge.
 *   - Part-specific Claude grading prompts (distinct promptHash per ExamPart).
 *
 * Read-only. The only network calls are tiny key-probe pings (≤8 tokens).
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { CertLevel, CertType, ExamPart } from '@prisma/client';
import { parseRubric, parseL3Reference } from './modules/grading/rubric';
import { L3PracticalGraderService, parseL3Submission } from './modules/grading/l3-practical-grader.service';
import { planGrading, mergeRationale, claudeToPersist, l3ToPersist } from './modules/grading/grading-strategy';
import { getScoring, computeWeightedResult } from './modules/cbtSessions/exam-spec';
import { l3ClientView } from './modules/cbtExams/cbt-exams.service';
import {
  ClaudeEssayGraderService,
  EssayGradeResult,
  EssayGradeTask,
} from './integrations/anthropic/claude-essay-grader.service';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`   ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`   ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(title: string): void {
  console.log(`\n▶ ${title}`);
}

// ── Sample L3 실습형 rubric wrappers (production shape, seed-l3-practicals.ts) ──
const 현업적용_RUBRIC = {
  practiceType: '현업적용형',
  responseFormat: { select: ['AI 활용 가능 작업', '제외해야 할 입력자료'], short_reason: '80~150자' },
  answerKey: {
    ai_usable_tasks: ['보도자료 초안 작성', '회의록 요약'],
    must_exclude_input: '고객 개인정보가 포함된 원본 명단',
    key_reason: '개인정보와 미확정 수치는 외부 AI 입력에서 제외하고 사람이 최종 검토해야 한다',
  },
  rubric: [
    { criterion: 'AI 활용 작업 선정', points: 5 },
    { criterion: '제외 입력자료', points: 4 },
    { criterion: '근거', points: 1 },
  ],
};
const 리스크판단_RUBRIC = {
  practiceType: '리스크 판단형',
  responseFormat: {
    select_highest_risk: ['개인정보 외부 입력', '오탈자'],
    select_immediate_action: '입력 중단 및 비식별·승인된 환경 사용',
    short_reason: '80~150자',
  },
  answerKey: {
    highest_risk: '개인정보 외부 입력',
    immediate_action: '입력 중단 및 비식별·승인된 환경 사용',
    key_reason: '식별 가능한 개인정보를 외부 AI에 입력하면 유출 위험이 크다',
  },
  rubric: [{ criterion: '위험 식별', points: 5 }, { criterion: '즉시 조치', points: 4 }, { criterion: '근거', points: 1 }],
};

async function probeAnthropic(key: string): Promise<{ ok: boolean; kind: string; msg: string }> {
  try {
    await new Anthropic({ apiKey: key }).beta.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return { ok: true, kind: 'VALID', msg: 'authenticated, has credits' };
  } catch (e) {
    const err = e as { status?: number; message?: string; error?: { error?: { message?: string } } };
    const status = err.status;
    const msg = String(err.error?.error?.message ?? err.message ?? e);
    if (status === 401) return { ok: false, kind: 'INVALID_KEY', msg };
    if (status === 400 && /credit balance/i.test(msg)) return { ok: false, kind: 'NO_CREDITS', msg };
    if (status === 429) return { ok: false, kind: 'RATE_LIMITED', msg };
    return { ok: false, kind: 'OTHER', msg: `${status ?? '?'} ${msg}` };
  }
}

async function probeGemini(key: string): Promise<{ ok: boolean; kind: string; msg: string }> {
  try {
    // Lazy import so a missing SDK doesn't crash the whole run.
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
    const r = await model.generateContent('Reply with the single word: OK');
    return { ok: true, kind: 'VALID', msg: `reply: ${r.response.text().trim().slice(0, 12)}` };
  } catch (e) {
    const err = e as { status?: number; message?: string };
    const msg = String(err.message ?? e);
    if (/api[_ ]?key[_ ]?(not valid|invalid)/i.test(msg)) return { ok: false, kind: 'INVALID_KEY', msg };
    if (err.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) return { ok: false, kind: 'QUOTA', msg };
    return { ok: false, kind: 'OTHER', msg: `${err.status ?? '?'} ${msg}` };
  }
}

async function checkAiKeys(): Promise<void> {
  section('AI provider keys (live auth probes)');
  const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
  const geminiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  const upstageKey = process.env.UPSTAGE_API_KEY || process.env.UPSTAGEAI_SECRET_KEY || '';

  check('ANTHROPIC_API_KEY present', !!anthropicKey, anthropicKey ? `…${anthropicKey.slice(-4)}` : 'missing');
  if (anthropicKey) {
    const r = await probeAnthropic(anthropicKey);
    check(`Anthropic (claude-opus-4-8) live: ${r.kind}`, r.ok, r.msg.slice(0, 90));
  }

  check('GEMINI_API_KEY present', !!geminiKey, geminiKey ? `…${geminiKey.slice(-4)}` : 'missing');
  if (geminiKey) {
    const r = await probeGemini(geminiKey);
    check(`Gemini (proctor vision) live: ${r.kind}`, r.ok, r.msg.slice(0, 90));
  }

  // Upstage document-parse needs a file upload to probe live — presence only here.
  check('UPSTAGE key present (doc parsing)', !!upstageKey, upstageKey ? `…${upstageKey.slice(-4)}` : 'missing');
}

function checkRubricAndL3Grader(): void {
  section('Rubric parsing + L3 answer-key grader');
  const grader = new L3PracticalGraderService();

  // parseRubric: L3 wrapper → weighted criteria (no generic "Overall" collapse).
  const crit = parseRubric(현업적용_RUBRIC, 10);
  check('parseRubric L3 → weighted criteria',
    crit.length === 3 && crit.reduce((s, c) => s + c.maxPoints, 0) === 10,
    `${crit.length} criteria, ${crit.reduce((s, c) => s + c.maxPoints, 0)}pt`);
  const ref = parseL3Reference(현업적용_RUBRIC);
  check('parseL3Reference extracts practiceType/answerKey', ref?.practiceType === '현업적용형' && !!ref?.answerKey);
  check('parseL3Reference → null for legacy L1/L2', parseL3Reference({ criteria: ['A(10점)'] }) === null);

  // Strong 현업적용형 answer → high score, no expert review, no risk.
  const good = parseL3Submission(JSON.stringify({
    version: 1,
    selects: { ai_usable_tasks: ['보도자료 초안 작성', '회의록 요약'], must_exclude_input: '고객 개인정보가 포함된 원본 명단' },
    shortReason: '고객 개인정보와 미확정 수치는 외부 AI 입력에서 제외하고, 담당자가 수치와 법적 표현을 최종 검토해야 개인정보 유출과 오류를 막을 수 있다.',
  }))!;
  const goodRes = grader.gradeL3Practical({ points: 10, rubric: 현업적용_RUBRIC }, good);
  check('L3 strong answer → high pct', goodRes.pct >= 85, `pct ${goodRes.pct}`);
  check('L3 strong answer → no expert review', goodRes.needsExpertReview === false);
  check('L3 strong answer → no risk flags', goodRes.riskFlags.length === 0);

  // Wrong risk-type answer → expert review + risk_item_low_score flag.
  const wrong = parseL3Submission(JSON.stringify({
    version: 1,
    selects: { highest_risk: '오탈자', immediate_action: '맞춤법 검사' },
    shortReason: '문서를 다시 읽어보며 맞춤법을 점검하는 것이 우선이라고 생각한다는 취지의 답안입니다.',
  }))!;
  const wrongRes = grader.gradeL3Practical({ points: 10, rubric: 리스크판단_RUBRIC }, wrong);
  check('L3 risk-type low → needsExpertReview', wrongRes.needsExpertReview === true, `pct ${wrongRes.pct}`);
  check('L3 risk-type low → risk_item_low_score flag',
    wrongRes.riskFlags.some((f) => f.code === 'risk_item_low_score'));

  // PII in rationale → HIGH flag + review.
  const pii = parseL3Submission(JSON.stringify({
    version: 1,
    selects: { highest_risk: '개인정보 외부 입력', immediate_action: '입력 중단 및 비식별·승인된 환경 사용' },
    shortReason: '담당자 홍길동 010-1234-5678 에게 확인 후 개인정보 외부 입력을 즉시 중단해야 한다.',
  }))!;
  const piiRes = grader.gradeL3Practical({ points: 10, rubric: 리스크판단_RUBRIC }, pii);
  check('L3 PII in rationale → HIGH flag',
    piiRes.riskFlags.some((f) => f.code === 'phone_number' && f.severity === 'HIGH'));
}

function checkSubmissionAndClientView(): void {
  section('Submission envelope + paper client-view (no answerKey leak)');

  // Envelope unwrap + legacy free-text.
  const env = parseL3Submission(JSON.stringify({ version: 1, selects: { required_issues: ['a'] }, shortReason: '근거' }));
  check('parseL3Submission unwraps {selects, shortReason}',
    env?.rationale === '근거' && Array.isArray(env?.selections.required_issues));
  check('parseL3Submission → null on legacy free-text', parseL3Submission('예전 자유서술 답안입니다.') === null);

  // Client view: keyed by answerKey field names, options from responseFormat,
  // and the answerKey VALUES / key_reason must NEVER be serialized.
  const view = l3ClientView(리스크판단_RUBRIC)!;
  const json = JSON.stringify(view);
  check('l3ClientView fields keyed by answerKey names',
    view.fields.some((f) => f.key === 'highest_risk') && view.fields.some((f) => f.key === 'immediate_action'));
  check('l3ClientView attaches responseFormat option pool',
    (view.fields.find((f) => f.key === 'highest_risk')?.options ?? []).includes('개인정보 외부 입력'));
  check('l3ClientView NEVER leaks key_reason', !json.includes('key_reason') && !json.includes('유출 위험이 크다'));
  check('l3ClientView → null for legacy rubric', l3ClientView({ criteria: ['A(10점)'] }) === null);
}

function checkDispatchAndWeighting(): void {
  section('Dispatch routing + weighted-100 pass math + hybrid merge');

  check('planGrading L3 PRACTICAL → l3_answer_key',
    planGrading({ level: CertLevel.L3, part: ExamPart.PRACTICAL, isCodeTask: false }).strategy === 'l3_answer_key');
  const l2 = planGrading({ level: CertLevel.L2, part: ExamPart.PRACTICAL, isCodeTask: false });
  check('planGrading L2 PRACTICAL → claude_rubric + aiChatLog', l2.strategy === 'claude_rubric' && l2.includeChatLog === true);
  const essay = planGrading({ level: CertLevel.L1, part: ExamPart.ESSAY, isCodeTask: false });
  check('planGrading L1 ESSAY → claude_rubric, no aiChatLog', essay.strategy === 'claude_rubric' && essay.includeChatLog === false);
  const code = planGrading({ level: CertLevel.L2, part: ExamPart.PRACTICAL, isCodeTask: true });
  check('planGrading AXIS-C code → execution summary on', code.includeExecutionSummary === true);

  const prev = process.env.L3_PRACTICALS_ENABLED;
  process.env.L3_PRACTICALS_ENABLED = 'true';
  const scoring = getScoring(CertType.AXIS, CertLevel.L3, '1.1');
  const win = computeWeightedResult(scoring, (p) => (p === ExamPart.WRITTEN ? 80 : 85));
  check('L3 written 80% + practical 85% → total 82, pass', win.total === 82 && win.passed, `total ${win.total}`);
  const floorFail = computeWeightedResult(scoring, (p) => (p === ExamPart.WRITTEN ? 100 : 55));
  check('L3 practical 55% → fails 60% floor', !floorFail.passed && floorFail.floorFailures.includes(ExamPart.PRACTICAL));
  if (prev === undefined) delete process.env.L3_PRACTICALS_ENABLED;
  else process.env.L3_PRACTICALS_ENABLED = prev;

  // Hybrid merge: Claude re-scores only the rationale criterion; objective kept.
  const grader = new L3PracticalGraderService();
  const sub = parseL3Submission(JSON.stringify({
    version: 1,
    selects: { ai_usable_tasks: ['보도자료 초안 작성', '회의록 요약'], must_exclude_input: '고객 개인정보가 포함된 원본 명단' },
    shortReason: '개인정보 보호를 위해 담당자가 신중하게 검토해야 한다.',
  }))!;
  const base = grader.gradeL3Practical({ points: 10, rubric: 현업적용_RUBRIC }, sub);
  const claudeRationale: EssayGradeResult = {
    criterionScores: [{ key: 'C3', label: '근거', maxPoints: 1, score: 1 }], total: 1, maxTotal: 1, pct: 100,
    band: 'normal', riskFlags: [],
    gate: { triggered: false, rule: '선택-근거 일치 게이트', contradiction: null },
    criticalFailCandidates: [], injectionSuspected: false,
    confidence: 0.8, rationale: 'ok', model: 'claude-opus-4-8',
    promptHash: 'h', promptVersion: 'AXIS-L3-AI-SCORING-PROMPT-v1.0', latencyMs: 10, degraded: false,
  };
  const merged = mergeRationale(base, claudeRationale, 10);
  check('mergeRationale keeps objective, updates rationale',
    merged.breakdown.objectiveScore === base.breakdown.objectiveScore && merged.breakdown.rationaleScore === 1);
  check('l3ToPersist(hybrid) → aiModel hybrid-l3+claude', l3ToPersist(merged, 'hybrid-l3+claude', 0.8).model === 'hybrid-l3+claude');
  const claudePersist = claudeToPersist(claudeRationale);
  check('claudeToPersist maps total→earnedPoints', claudePersist.earnedPoints === 1 && claudePersist.model === 'claude-opus-4-8');
}

async function checkPartPrompts(): Promise<void> {
  section('Part-specific Claude grading prompts (offline hash)');
  // Offline grader (no key) still computes the promptHash it WOULD send.
  const offline = new ClaudeEssayGraderService({ get: () => undefined } as unknown as import('@nestjs/config').ConfigService);
  const task: EssayGradeTask = { title: 't', scenario: 's', points: 10, criteria: [{ key: 'C1', label: 'x', maxPoints: 10 }] };
  const sub = { contentText: '답안' };
  const p = await offline.grade(task, sub, ExamPart.PRACTICAL);
  const d = await offline.grade(task, sub, ExamPart.DELIVERABLE);
  const e = await offline.grade(task, sub, ExamPart.ESSAY);
  check('distinct promptHash per part', new Set([p.promptHash, d.promptHash, e.promptHash]).size === 3);
  const p2 = await offline.grade(task, sub, ExamPart.PRACTICAL);
  check('same part → stable promptHash', p.promptHash === p2.promptHash);
  check('offline grade degrades (no key) but never throws', p.degraded === true);
}

async function main(): Promise<void> {
  console.log('🧪 AXIS ALL-IN-ONE SMOKE TEST\n' + '='.repeat(60));
  await checkAiKeys();
  checkRubricAndL3Grader();
  checkSubmissionAndClientView();
  checkDispatchAndWeighting();
  await checkPartPrompts();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) console.log(`FAILED: ${failures.join(' · ')}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});

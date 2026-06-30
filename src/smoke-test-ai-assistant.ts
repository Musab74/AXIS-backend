/**
 * AXIS IN-EXAM AI ASSISTANT SMOKE TEST
 *
 *   npm run smoke:ai
 *
 * Verifies that ANTHROPIC_API_KEY is valid and that the practical-exam AI
 * assistant produces a real, grounded Korean response through the SAME service
 * the exam runner calls (ClaudeExamAssistantService, model claude-opus-4-8).
 *
 * Read-only — makes live Claude API calls, writes nothing to the database.
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeExamAssistantService } from './integrations/anthropic/claude-exam-assistant.service';

/**
 * Low-level probe that classifies exactly what's wrong with the key, so the
 * result is actionable: VALID / INVALID_KEY / NO_CREDITS / RATE_LIMITED / OTHER.
 */
async function probeKey(key: string): Promise<{ ok: boolean; kind: string; message: string }> {
  try {
    await new Anthropic({ apiKey: key }).beta.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return { ok: true, kind: 'VALID', message: 'authenticated, has credits' };
  } catch (e: any) {
    const status = e?.status;
    const msg = String(e?.error?.error?.message ?? e?.message ?? e);
    if (status === 401) return { ok: false, kind: 'INVALID_KEY', message: msg };
    if (status === 400 && /credit balance/i.test(msg)) return { ok: false, kind: 'NO_CREDITS', message: msg };
    if (status === 429) return { ok: false, kind: 'RATE_LIMITED', message: msg };
    return { ok: false, kind: 'OTHER', message: `${status ?? '?'} ${msg}` };
  }
}

function makeConfig() {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
  return { get: (k: string) => (k === 'ai.anthropicApiKey' ? key : undefined) } as any;
}

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    pass++;
    console.log(`   ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`   ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('🧪 IN-EXAM AI ASSISTANT SMOKE TEST\n' + '='.repeat(60));

  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
  console.log(`ANTHROPIC_API_KEY present: ${key ? 'yes' : 'no'}${key ? ` (sk-…${key.slice(-4)})` : ''}`);
  check('key is configured', !!key, key ? '' : 'set ANTHROPIC_API_KEY in .env');
  if (!key) {
    console.log('\n❌ Cannot run live checks without a key.\n');
    process.exitCode = 1;
    return;
  }

  // Classify the key state up front so the diagnosis is unambiguous.
  console.log('\n📋 Probe — classify the key');
  const probe = await probeKey(key);
  console.log(`   → ${probe.kind}: ${probe.message}`);
  check('key authenticates (not INVALID_KEY)', probe.kind !== 'INVALID_KEY');
  check('account has credits (not NO_CREDITS)', probe.kind !== 'NO_CREDITS');
  if (!probe.ok) {
    const fix =
      probe.kind === 'INVALID_KEY'
        ? 'The key is wrong/revoked — set a valid ANTHROPIC_API_KEY in .env.'
        : probe.kind === 'NO_CREDITS'
          ? 'The key is VALID but the Anthropic account has no credits — top up at console.anthropic.com → Plans & Billing.'
          : probe.kind === 'RATE_LIMITED'
            ? 'Rate limited — retry shortly.'
            : 'Unexpected API error — see message above.';
    console.log('\n' + '='.repeat(60));
    console.log(`Result: ${pass} passed, ${fail} failed`);
    console.log(`\n❌ AI ASSISTANT NOT WORKING — ${probe.kind}.\n   Fix: ${fix}\n`);
    process.exitCode = 1;
    return;
  }

  const svc = new ClaudeExamAssistantService(makeConfig());
  check('service reports configured', svc.isConfigured());

  const task = {
    title: '업무 문서 작성',
    scenario:
      '당신은 ㈜사아자 영업팀 대리입니다. 신규 거래처 ㈜하늘테크에 제출할 "IT 솔루션 도입 제안서"를 AI를 활용하여 작성해달라는 요청을 받았습니다. 대상: 거래처 의사결정자(CTO), 톤: 전문적·신뢰감, 분량: A4 3~4페이지.',
    requiredStructure: '1.회사 소개 2.솔루션 개요 3.기대 효과 4.도입 일정 5.비용 6.레퍼런스',
    aiToolAllowed: 'LMS 내장 AI',
  };

  // 1) Single grounded turn.
  console.log('\n📋 Turn 1 — ask for a proposal outline');
  const t0 = Date.now();
  const r1 = await svc.respond(task, [], '이 제안서의 목차를 요구 구성에 맞춰 추천해줘.');
  const ms1 = Date.now() - t0;
  check('not degraded (live reply received)', !r1.degraded, `${ms1}ms`);
  check('reply is non-empty', r1.text.trim().length > 0, `${r1.text.length} chars`);
  check('reply is in Korean', /[가-힣]/.test(r1.text));
  check(
    'reply is grounded in the task (mentions 제안서/솔루션/도입)',
    /(제안서|솔루션|도입|레퍼런스|일정|비용)/.test(r1.text),
  );
  console.log('   ── reply preview ──');
  console.log('   ' + r1.text.split('\n').slice(0, 6).join('\n   '));

  // 2) Multi-turn — history is carried.
  console.log('\n📋 Turn 2 — follow-up using prior context');
  const history = [
    { role: 'user' as const, text: '이 제안서의 목차를 추천해줘.' },
    { role: 'assistant' as const, text: r1.text },
  ];
  const r2 = await svc.respond(task, history, '방금 3번 항목(기대 효과)만 더 구체적으로 풀어줘.');
  check('follow-up not degraded', !r2.degraded);
  check('follow-up non-empty Korean', r2.text.trim().length > 0 && /[가-힣]/.test(r2.text));

  // 3) Off-topic request should be politely redirected, not answered.
  console.log('\n📋 Turn 3 — off-topic guardrail');
  const r3 = await svc.respond(task, [], '시험이랑 상관없는데, 오늘 서울 날씨 알려줘.');
  check('off-topic handled without error', !r3.degraded && r3.text.trim().length > 0);
  console.log('   off-topic reply preview: ' + r3.text.slice(0, 120).replace(/\n/g, ' '));

  console.log('\n' + '='.repeat(60));
  console.log(`Result: ${pass} passed, ${fail} failed`);
  console.log(fail === 0 ? '✅ AI ASSISTANT SMOKE PASSED — key works, replies are live\n' : '❌ AI ASSISTANT SMOKE FAILED\n');
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

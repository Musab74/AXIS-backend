/**
 * AXIS GEMINI (proctor vision) SMOKE TEST
 *
 *   npm run smoke:gemini
 *
 * Verifies that GEMINI_API_KEY is valid and that the proctor screening path
 * works through the SAME service the live proctor calls (GeminiVisionService,
 * model gemini-2.5-flash-lite). Classifies the key state so the result is
 * actionable: VALID / INVALID_KEY / QUOTA / PERMISSION / OTHER.
 *
 * Read-only — makes live Gemini API calls, writes nothing to the database.
 */
import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import sharp from 'sharp';
import { GeminiVisionService } from './integrations/googleGemini/google-gemini.service';

function makeConfig() {
  const key =
    process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  return { get: (k: string) => (k === 'ai.geminiApiKey' ? key : undefined) } as any;
}

async function probeKey(key: string): Promise<{ ok: boolean; kind: string; message: string }> {
  try {
    const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
    const r = await model.generateContent('Reply with the single word: OK');
    return { ok: true, kind: 'VALID', message: `authenticated (reply: ${r.response.text().trim().slice(0, 20)})` };
  } catch (e: any) {
    const status = e?.status;
    const msg = String(e?.message ?? e);
    if (status === 400 && /api[_ ]?key[_ ]?(not valid|invalid)/i.test(msg)) return { ok: false, kind: 'INVALID_KEY', message: msg };
    if (/CONSUMER_SUSPENDED|has been suspended/i.test(msg)) return { ok: false, kind: 'SUSPENDED', message: msg };
    if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) return { ok: false, kind: 'QUOTA', message: msg };
    if (status === 403 || /PERMISSION_DENIED/i.test(msg)) return { ok: false, kind: 'PERMISSION', message: msg };
    return { ok: false, kind: 'OTHER', message: `${status ?? '?'} ${msg}` };
  }
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
  console.log('🧪 GEMINI (proctor vision) SMOKE TEST\n' + '='.repeat(60));

  const key =
    process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  console.log(`GEMINI_API_KEY present: ${key ? 'yes' : 'no'}${key ? ` (…${key.slice(-4)})` : ''}`);
  check('key is configured', !!key, key ? '' : 'set GEMINI_API_KEY in .env');
  if (!key) {
    console.log('\n❌ Cannot run live checks without a key.\n');
    process.exitCode = 1;
    return;
  }

  console.log('\n📋 Probe — classify the key');
  const probe = await probeKey(key);
  console.log(`   → ${probe.kind}: ${probe.message}`);
  check('Gemini API is usable with this key', probe.ok, probe.ok ? '' : probe.kind);
  if (!probe.ok) {
    const fix =
      probe.kind === 'INVALID_KEY'
        ? 'The key is wrong/revoked — set a valid GEMINI_API_KEY in .env.'
        : probe.kind === 'SUSPENDED'
          ? 'The Google Cloud project / API key behind this key is SUSPENDED — restore it in Google Cloud console (Billing/abuse hold) or issue a new key from an active project and update GEMINI_API_KEY.'
          : probe.kind === 'QUOTA'
            ? 'Daily/quota limit hit — wait for reset or raise quota in Google AI Studio / Cloud console.'
            : probe.kind === 'PERMISSION'
              ? 'Key lacks access to gemini-2.5-flash-lite — enable the Generative Language API / check restrictions.'
              : 'Unexpected API error — see message above.';
    console.log('\n' + '='.repeat(60));
    console.log(`Result: ${pass} passed, ${fail} failed`);
    console.log(`\n❌ GEMINI NOT WORKING — ${probe.kind}.\n   Fix: ${fix}\n`);
    process.exitCode = 1;
    return;
  }

  // Exercise the REAL proctor service end-to-end with a synthetic frame.
  const svc = new GeminiVisionService(makeConfig());
  check('service reports configured', svc.isConfigured());

  console.log('\n📋 Screen — real GeminiVisionService.screen() on a synthetic frame');
  const frame = await sharp({
    create: { width: 480, height: 360, channels: 3, background: { r: 120, g: 120, b: 120 } },
  })
    .jpeg({ quality: 70 })
    .toBuffer();

  const t0 = Date.now();
  const res = await svc.screen(frame, {
    sessionId: 'smoke-gemini',
    userId: 'smoke',
    certType: 'AXIS',
    level: 'L2',
    ts: 0,
  });
  const ms = Date.now() - t0;
  check('screen() not degraded (live structured reply)', !res.degraded, `${ms}ms`);
  check('returns a boolean suspicious flag', typeof res.suspicious === 'boolean', `suspicious=${res.suspicious}`);
  check('returns a numeric confidence', typeof res.confidence === 'number', `confidence=${res.confidence}`);
  check('returns a flags array', Array.isArray(res.flags), `flags=[${res.flags.join(',')}]`);
  check('reported token usage', res.inputTokens > 0, `in=${res.inputTokens} out=${res.outputTokens}`);
  console.log(`   notes: ${res.notes}`);

  console.log('\n' + '='.repeat(60));
  console.log(`Result: ${pass} passed, ${fail} failed`);
  console.log(fail === 0 ? '✅ GEMINI SMOKE PASSED — key works, vision screening is live\n' : '❌ GEMINI SMOKE FAILED\n');
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

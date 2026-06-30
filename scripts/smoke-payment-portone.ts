/**
 * PortOne payment diagnostic smoke — finds the failing layer (no silent pass).
 *
 * Mirrors /apply Step 5: login → quick-book → /payment/request → PortOne VA → /payment/confirm
 *
 * Usage:
 *   npm run smoke:payment
 *   SMOKE_BASE_URL=https://api.axisexam.com npm run smoke:payment
 *   SMOKE_PAYMENT_MODE=local npm run smoke:payment   # skip PortOne (staging only)
 *
 * Exit 0 only when the full PortOne path succeeds (or local mode explicitly set).
 */
import { config } from 'dotenv';
import { resolve } from 'path';
import { PortOneClient } from '@portone/server-sdk';
import { PaymentMethod, PrismaClient } from '@prisma/client';

config({ path: resolve(__dirname, '../.env'), override: true }); // axis-backend/.env only

const BASE = (process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3333').replace(/\/$/, '');
const USER_ID = process.env.SMOKE_USER_ID ?? 'test000';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'test1111';
const CERT = process.env.SMOKE_CERT_TYPE ?? 'AXIS';
const LEVEL = process.env.SMOKE_LEVEL ?? 'L3';
const MODE = (process.env.SMOKE_PAYMENT_MODE ?? 'portone').toLowerCase();
const NODE_ENV = process.env.NODE_ENV ?? 'development';

type Json = Record<string, unknown>;
type StepResult = { id: string; ok: boolean; detail: string };

const steps: StepResult[] = [];

function record(id: string, ok: boolean, detail: string) {
  steps.push({ id, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${id}: ${detail}`);
}

function formatHttpBody(body: unknown): string {
  if (body === null || body === undefined) return '(empty)';
  if (typeof body === 'string') return body.slice(0, 500);
  if (typeof body === 'object') {
    const o = body as Json;
    if (typeof o.message === 'string') return o.message;
    if (Array.isArray(o.message)) return o.message.map(String).join('; ');
    if (typeof o.error === 'string') return o.error;
    return JSON.stringify(o).slice(0, 500);
  }
  return String(body);
}

function portoneErrorDetail(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const err = e as { name?: string; message?: string; data?: unknown };
    const parts: string[] = [];
    if (err.name) parts.push(err.name);
    if (err.message?.trim()) parts.push(err.message.trim());
    if (err.data !== undefined && err.data !== null) {
      const d = err.data;
      if (typeof d === 'object') {
        const o = d as Json;
        if (o.type) parts.push(`type=${String(o.type)}`);
        if (o.message) parts.push(String(o.message));
        else parts.push(JSON.stringify(d).slice(0, 400));
      } else {
        parts.push(String(d));
      }
    }
    if (parts.length) return parts.join(' — ');
  }
  if (e instanceof Error && e.message.trim()) return e.message;
  return String(e);
}

function classifyPortoneVaFailure(detail: string): string {
  if (/invalid api secret|unauthorized/i.test(detail)) {
    return [
      'ROOT CAUSE: PORTONE_V2_API_SECRET is wrong or revoked.',
      'FIX: PortOne console → 결제 연동 → V2 API Secret → paste into axis-backend/.env → pm2 restart axis-backend --update-env',
    ].join('\n  ');
  }
  if (/KCP_BILLING|KCP 에 대해|지원하지 않는 기능/i.test(detail)) {
    return [
      'ROOT CAUSE: PORTONE_CHANNEL_KEY points at a KCP_BILLING channel that cannot issue virtual accounts.',
      'This matches the browser toast "서버 연결 실패" — PortOne SDK fails before /payment/confirm runs.',
      'FIX: In PortOne admin, use a channel that supports 가상계좌 (VA), not billing-only. Update PORTONE_CHANNEL_KEY + VITE_PORTONE_CHANNEL_KEY, restart backend & rebuild frontend.',
    ].join('\n  ');
  }
  if (/channel/i.test(detail)) {
    return [
      'ROOT CAUSE: PortOne channel misconfiguration (key/store mismatch or VA disabled).',
      'FIX: Verify PORTONE_STORE_ID + PORTONE_CHANNEL_KEY pair in PortOne console.',
    ].join('\n  ');
  }
  return 'FIX: See PortOne admin test-mode docs for VA on your PG (KCP/NHN).';
}

function classifyConfirmFailure(status: number, body: unknown): string {
  const text = formatHttpBody(body);
  if (status === 401) {
    return 'ROOT CAUSE: JWT expired or missing on /payment/confirm.';
  }
  if (/NETWORK_RETRY_EXCEEDED/i.test(text)) {
    return [
      'ROOT CAUSE: Backend could not call PortOne getPayment (network or invalid PORTONE_V2_API_SECRET).',
      'FIX: Valid V2 secret + outbound HTTPS to api.portone.io.',
    ].join('\n  ');
  }
  if (/unexpected_status/i.test(text)) {
    return [
      'ROOT CAUSE: PortOne payment status is not VIRTUAL_ACCOUNT_ISSUED / PAID when confirm runs.',
      'Usually: user closed PortOne popup, or VA was never issued on this merchantId.',
    ].join('\n  ');
  }
  if (/amount_mismatch/i.test(text)) {
    return 'ROOT CAUSE: PortOne amount ≠ DB payment.amount.';
  }
  return `ROOT CAUSE: /payment/confirm HTTP ${status} — ${text}`;
}

function failWithReport(rootCause: string): never {
  console.error('\n========== DIAGNOSIS ==========');
  console.error(rootCause);
  console.error('\n--- Step summary ---');
  for (const s of steps) {
    console.error(`  [${s.ok ? 'PASS' : 'FAIL'}] ${s.id}: ${s.detail}`);
  }
  console.error('==============================\n');
  process.exit(1);
}

async function apiRaw(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { raw: text };
    }
  }
  return { ok: res.ok, status: res.status, body };
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    record('env', false, `Missing ${name}`);
    failWithReport(`ROOT CAUSE: ${name} not set in axis-backend/.env`);
  }
  return v!;
}

function buildLocalVaSnapshot(total: number, pgId: string) {
  return {
    id: pgId,
    status: 'VIRTUAL_ACCOUNT_ISSUED',
    amount: { total },
    method: {
      type: 'PaymentMethodVirtualAccount',
      accountNumber: '12345678901234',
      bank: 'KOOKMIN',
      expiredAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
    },
  };
}

async function probePortoneSecret(secret: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch('https://api.portone.io/login/api-secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiSecret: secret }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as Json;
    if (res.ok) return { ok: true, detail: 'V2 API secret accepted by PortOne' };
    return {
      ok: false,
      detail: `HTTP ${res.status} ${String(body.message ?? body.type ?? 'rejected')}`,
    };
  } catch (e) {
    return { ok: false, detail: `Cannot reach api.portone.io: ${String(e)}` };
  }
}

async function main() {
  console.log(`== PortOne payment diagnostic (BASE=${BASE}, MODE=${MODE}) ==\n`);

  const storeId = requireEnv('PORTONE_STORE_ID');
  const channelKey = requireEnv('PORTONE_CHANNEL_KEY');
  const secret = requireEnv('PORTONE_V2_API_SECRET');

  // 1 — Backend
  try {
    const health = await fetch(`${BASE}/api-docs-json`, { signal: AbortSignal.timeout(8_000) });
    if (!health.ok) {
      record('backend', false, `HTTP ${health.status}`);
      failWithReport(
        `ROOT CAUSE: AXIS API not reachable at ${BASE}.\n  FIX: pm2 restart axis-backend --update-env`,
      );
    }
    record('backend', true, `${BASE}/api-docs-json → 200`);
  } catch (e) {
    record('backend', false, String(e));
    failWithReport(`ROOT CAUSE: Cannot connect to ${BASE} — ${String(e)}`);
  }

  // 2 — Login
  const loginRes = await apiRaw('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ userId: USER_ID, password: PASSWORD }),
  });
  if (!loginRes.ok) {
    record('auth.login', false, `HTTP ${loginRes.status} ${formatHttpBody(loginRes.body)}`);
    failWithReport(
      `ROOT CAUSE: Login failed for ${USER_ID}.\n  FIX: npm run db:seed:payment-checker`,
    );
  }
  const token = (loginRes.body as { accessToken?: string }).accessToken;
  if (!token) {
    record('auth.login', false, 'no accessToken in response');
    failWithReport('ROOT CAUSE: Login response missing accessToken');
  }
  record('auth.login', true, `userId=${USER_ID}`);

  // 3 — quick-book
  const bookRes = await apiRaw('/registrations/quick-book', {
    method: 'POST',
    token,
    body: JSON.stringify({ certType: CERT, level: LEVEL }),
  });
  if (!bookRes.ok) {
    record('registrations.quick-book', false, `HTTP ${bookRes.status} ${formatHttpBody(bookRes.body)}`);
    failWithReport(classifyConfirmFailure(bookRes.status, bookRes.body));
  }
  const registrationId = (bookRes.body as { registration?: { id: string } }).registration?.id;
  if (!registrationId) {
    record('registrations.quick-book', false, 'missing registration.id');
    failWithReport('ROOT CAUSE: quick-book returned no registration id');
  }
  record('registrations.quick-book', true, `registrationId=${registrationId}`);

  // 4 — /payment/request (same as apply page load)
  const reqRes = await apiRaw('/payment/request', {
    method: 'POST',
    token,
    body: JSON.stringify({ registrationId }),
  });
  if (!reqRes.ok) {
    record('payment.request', false, `HTTP ${reqRes.status} ${formatHttpBody(reqRes.body)}`);
    failWithReport(classifyConfirmFailure(reqRes.status, reqRes.body));
  }
  const reqParams = reqRes.body as {
    merchantId?: string;
    orderName?: string;
    totalAmount?: number;
    channelKey?: string;
    storeId?: string;
    alreadyIssued?: boolean;
  };
  const merchantId = reqParams.merchantId;
  if (!merchantId || reqParams.totalAmount === undefined) {
    record('payment.request', false, 'missing merchantId or totalAmount');
    failWithReport('ROOT CAUSE: /payment/request response incomplete');
  }
  record(
    'payment.request',
    true,
    `merchantId=${merchantId} amount=${reqParams.totalAmount} channelKey=${(reqParams.channelKey ?? channelKey).slice(0, 24)}…`,
  );

  if (reqParams.channelKey && reqParams.channelKey !== channelKey) {
    record(
      'env.channelKey',
      false,
      `response channelKey ≠ PORTONE_CHANNEL_KEY in .env (backend may be stale — pm2 restart --update-env)`,
    );
  } else {
    record('env.channelKey', true, 'matches /payment/request');
  }
  if (reqParams.storeId && reqParams.storeId !== storeId) {
    record('env.storeId', false, 'response storeId ≠ PORTONE_STORE_ID in .env');
  } else {
    record('env.storeId', true, 'matches /payment/request');
  }

  let remoteId = merchantId;
  let skipPortone = MODE === 'local';

  if (MODE === 'local' && NODE_ENV === 'production') {
    failWithReport('ROOT CAUSE: SMOKE_PAYMENT_MODE=local forbidden when NODE_ENV=production');
  }

  if (!skipPortone) {
    // 5 — PortOne API secret
    const secretProbe = await probePortoneSecret(secret);
    record('portone.api-secret', secretProbe.ok, secretProbe.detail);
    if (!secretProbe.ok) {
      failWithReport(classifyPortoneVaFailure(secretProbe.detail));
    }

    // 6 — PortOne VA issue (API equivalent of browser requestPayment)
    const portone = PortOneClient({ secret, storeId });
    let payDetail = '';
    try {
      await portone.payment.payInstantly({
        paymentId: merchantId,
        storeId,
        channelKey: reqParams.channelKey || channelKey,
        orderName: reqParams.orderName ?? 'AXIS smoke',
        currency: 'KRW',
        amount: { total: reqParams.totalAmount },
        customer: {
          name: { full: 'Payment Smoke' },
          email: 'smoke@axisexam.local',
          phoneNumber: '01000000000',
        },
        method: {
          virtualAccount: {
            bank: 'KOOKMIN',
            expiry: { validHours: 72 },
            option: { type: 'NORMAL' },
          },
        },
      });
      record('portone.payInstantly', true, 'virtual account issued via API');
    } catch (e) {
      payDetail = portoneErrorDetail(e);
      record('portone.payInstantly', false, payDetail);
      failWithReport(classifyPortoneVaFailure(payDetail));
    }

    // 7 — getPayment (what /payment/confirm uses)
    let lastStatus = 'unknown';
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 600));
      try {
        const remote = (await portone.payment.getPayment({ paymentId: merchantId, storeId })) as {
          status?: string;
          id?: string;
        };
        lastStatus = String(remote.status ?? 'unknown');
        if (lastStatus === 'VIRTUAL_ACCOUNT_ISSUED' || lastStatus === 'PAID') {
          if (remote.id) remoteId = remote.id;
          record('portone.getPayment', true, `status=${lastStatus} id=${remoteId}`);
          break;
        }
      } catch (e) {
        record('portone.getPayment', false, portoneErrorDetail(e));
        failWithReport(classifyPortoneVaFailure(portoneErrorDetail(e)));
      }
      if (i === 4) {
        record('portone.getPayment', false, `status still ${lastStatus} after retries`);
        failWithReport(
          `ROOT CAUSE: PortOne payment never reached VIRTUAL_ACCOUNT_ISSUED (last=${lastStatus}).\n  ${classifyPortoneVaFailure('')}`,
        );
      }
    }
  } else {
    console.log('\nWARN: SMOKE_PAYMENT_MODE=local — skipping PortOne (not a production diagnosis)\n');
    const pgId = `smoke-local-${Date.now()}`;
    remoteId = pgId;
    const prismaLocal = new PrismaClient();
    try {
      await prismaLocal.payment.update({
        where: { orderId: merchantId },
        data: {
          paymentKey: pgId,
          method: PaymentMethod.VBANK,
          rawResponse: buildLocalVaSnapshot(reqParams.totalAmount!, pgId),
        },
      });
    } finally {
      await prismaLocal.$disconnect();
    }
    record('portone.payInstantly', true, '(skipped — local fixture)');
    record('portone.getPayment', true, '(skipped — local fixture)');
  }

  // 8 — /payment/confirm (runs only after PortOne VA in real flow)
  const confirmRes = await apiRaw('/payment/confirm', {
    method: 'POST',
    token,
    body: JSON.stringify({ paymentId: remoteId, merchantId }),
  });
  if (!confirmRes.ok) {
    record('payment.confirm', false, `HTTP ${confirmRes.status} ${formatHttpBody(confirmRes.body)}`);
    failWithReport(classifyConfirmFailure(confirmRes.status, confirmRes.body));
  }
  const confirmed = confirmRes.body as { ok?: boolean; status?: string; vbankNum?: string };
  if (!confirmed.ok || !confirmed.status || !['VA_ISSUED', 'PAID'].includes(confirmed.status)) {
    record('payment.confirm', false, JSON.stringify(confirmed).slice(0, 200));
    failWithReport(`ROOT CAUSE: Unexpected confirm body: ${JSON.stringify(confirmed)}`);
  }
  record(
    'payment.confirm',
    true,
    `status=${confirmed.status}${confirmed.vbankNum ? ` vbank=${confirmed.vbankNum}` : ''}`,
  );

  // 9 — DB
  const prisma = new PrismaClient();
  try {
    const row = await prisma.payment.findUnique({ where: { orderId: merchantId } });
    if (!row?.paymentKey) {
      record('db.payment', false, 'payment_key empty after confirm');
      failWithReport('ROOT CAUSE: DB payment_key not set after confirm');
    }
    if (confirmed.status === 'VA_ISSUED' && row.status !== 'PENDING') {
      record('db.payment', false, `expected PENDING got ${row.status}`);
      failWithReport(`ROOT CAUSE: DB status=${row.status} after VA_ISSUED`);
    }
    record('db.payment', true, `status=${row.status} payment_key set`);
  } finally {
    await prisma.$disconnect();
  }

  console.log('\n== All steps passed — full PortOne VA path OK ==');
  if (MODE === 'local') {
    console.log('(local mode: PortOne was not tested; use default portone mode before go-live)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

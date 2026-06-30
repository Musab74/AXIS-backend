/**
 * PortOne V1 (IAMPORT REST) payment smoke — mirrors /apply Step 4 with module v1.
 *
 * Usage:
 *   npm run smoke:payment:v1
 *   SMOKE_PAYMENT_MODE=local npm run smoke:payment:v1   # fixture VA (no browser)
 *   SMOKE_PAYMENT_MODE=portone npm run smoke:payment:v1  # reuse ready payment if exists
 *
 * Requires in axis-backend/.env:
 *   PORTONE_MODULE_VERSION=v1  (set by smoke script wrapper)
 *   PORTONE_V1_IMP_CODE, PORTONE_V1_IMP_KEY, PORTONE_V1_IMP_SECRET
 */
import { config } from 'dotenv';
import { resolve } from 'path';
import { PaymentMethod, PrismaClient } from '@prisma/client';
import { buildV1LocalVaSnapshot } from '../src/modules/payments/portone-v1-normalize';
import { PortoneV1Client } from '../src/modules/payments/portone-v1.client';

/** Always axis-backend/.env — never .env.example */
const ENV_PATH = resolve(__dirname, '../.env');
config({ path: ENV_PATH, override: true });
process.env.PORTONE_MODULE_VERSION = 'v1';

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
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}: ${detail}`);
}

function formatHttpBody(body: unknown): string {
  if (body === null || body === undefined) return '(empty)';
  if (typeof body === 'object') {
    const o = body as Json;
    if (typeof o.message === 'string') return o.message;
    if (typeof o.error === 'string') return o.error;
    return JSON.stringify(o).slice(0, 500);
  }
  return String(body);
}

function failWithReport(rootCause: string): never {
  console.error('\n========== DIAGNOSIS ==========');
  console.error(rootCause);
  for (const s of steps) {
    console.error(`  [${s.ok ? 'PASS' : 'FAIL'}] ${s.id}: ${s.detail}`);
  }
  console.error('==============================\n');
  process.exit(1);
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    record('env', false, `Missing ${name} in ${ENV_PATH}`);
    const hasV2 =
      !!process.env.PORTONE_V2_API_SECRET?.trim() &&
      !!process.env.PORTONE_STORE_ID?.trim();
    failWithReport(
      [
        `ROOT CAUSE: ${name} is not set in your real .env (${ENV_PATH}).`,
        hasV2
          ? '  You have PORTONE_V2_API_SECRET + PORTONE_STORE_ID in that file, but V1 IAMPORT REST needs separate keys (imp_code / REST API key / secret) — V2 secret does not work on api.iamport.kr.'
          : '  Add PORTONE_V1_IMP_CODE, PORTONE_V1_IMP_KEY, PORTONE_V1_IMP_SECRET from PortOne admin → V1 API Keys.',
        '  Or set PORTONE_MODULE_VERSION=v2 in the same .env to use your existing V2 credentials.',
      ].join('\n'),
    );
  }
  return v!;
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

async function main() {
  console.log(`== PortOne V1 payment smoke (BASE=${BASE}, MODE=${MODE}) ==\n`);

  const impCode = requireEnv('PORTONE_V1_IMP_CODE');
  const impKey = requireEnv('PORTONE_V1_IMP_KEY');
  const impSecret = requireEnv('PORTONE_V1_IMP_SECRET');
  const v1Client = new PortoneV1Client(impKey, impSecret);

  try {
    const health = await fetch(`${BASE}/api-docs-json`, { signal: AbortSignal.timeout(8_000) });
    if (!health.ok) {
      record('backend', false, `HTTP ${health.status}`);
      failWithReport(`ROOT CAUSE: API not reachable at ${BASE}`);
    }
    record('backend', true, `${BASE}/api-docs-json → 200`);
  } catch (e) {
    record('backend', false, String(e));
    failWithReport(`ROOT CAUSE: Cannot connect to ${BASE}`);
  }

  const credProbe = await v1Client.probeCredentials();
  record('portone.v1-token', credProbe.ok, credProbe.detail);
  if (!credProbe.ok) {
    failWithReport(
      'ROOT CAUSE: PORTONE_V1_IMP_KEY / PORTONE_V1_IMP_SECRET rejected by api.iamport.kr',
    );
  }

  const loginRes = await apiRaw('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ userId: USER_ID, password: PASSWORD }),
  });
  if (!loginRes.ok) {
    record('auth.login', false, formatHttpBody(loginRes.body));
    failWithReport(`ROOT CAUSE: Login failed for ${USER_ID}`);
  }
  const token = (loginRes.body as { accessToken?: string }).accessToken;
  if (!token) failWithReport('ROOT CAUSE: Login missing accessToken');
  record('auth.login', true, `userId=${USER_ID}`);

  const bookRes = await apiRaw('/registrations/quick-book', {
    method: 'POST',
    token,
    body: JSON.stringify({ certType: CERT, level: LEVEL }),
  });
  if (!bookRes.ok) {
    record('registrations.quick-book', false, formatHttpBody(bookRes.body));
    failWithReport(`ROOT CAUSE: quick-book HTTP ${bookRes.status}`);
  }
  const registrationId = (bookRes.body as { registration?: { id: string } }).registration?.id;
  if (!registrationId) failWithReport('ROOT CAUSE: quick-book missing registration.id');
  record('registrations.quick-book', true, `registrationId=${registrationId}`);

  const reqRes = await apiRaw('/payment/request', {
    method: 'POST',
    token,
    body: JSON.stringify({ registrationId }),
  });
  if (!reqRes.ok) {
    record('payment.request', false, formatHttpBody(reqRes.body));
    failWithReport(`ROOT CAUSE: /payment/request HTTP ${reqRes.status}`);
  }

  const reqParams = reqRes.body as {
    portoneVersion?: string;
    merchantId?: string;
    impCode?: string;
    totalAmount?: number;
    orderName?: string;
  };
  const merchantId = reqParams.merchantId;
  if (!merchantId || reqParams.totalAmount === undefined) {
    failWithReport('ROOT CAUSE: /payment/request incomplete');
  }
  if (reqParams.portoneVersion !== 'v1') {
    record(
      'env.moduleVersion',
      false,
      `backend returned portoneVersion=${String(reqParams.portoneVersion)} (restart with PORTONE_MODULE_VERSION=v1)`,
    );
    failWithReport('ROOT CAUSE: Backend not running with PORTONE_MODULE_VERSION=v1');
  }
  record('env.moduleVersion', true, 'portoneVersion=v1');
  if (reqParams.impCode !== impCode) {
    record('env.impCode', false, 'response impCode ≠ PORTONE_V1_IMP_CODE in .env');
  } else {
    record('env.impCode', true, 'matches /payment/request');
  }
  record(
    'payment.request',
    true,
    `merchantId=${merchantId} amount=${reqParams.totalAmount}`,
  );

  let impUid = process.env.SMOKE_V1_IMP_UID?.trim() ?? '';
  let skipPortone = MODE === 'local';

  if (MODE === 'local' && NODE_ENV === 'production') {
    failWithReport('ROOT CAUSE: SMOKE_PAYMENT_MODE=local forbidden when NODE_ENV=production');
  }

  if (!skipPortone && !impUid) {
    const ready = await v1Client.findPaymentByMerchantUid(merchantId, 'ready');
    if (ready?.imp_uid) {
      impUid = ready.imp_uid;
      record('portone.find-ready', true, `reused imp_uid=${impUid}`);
    } else {
      record(
        'portone.find-ready',
        false,
        'no ready payment — issue VA in browser (IMP.request_pay) or use SMOKE_PAYMENT_MODE=local',
      );
      console.log(
        '\nWARN: V1 has no server-side VA API; falling back to local fixture for confirm test.\n',
      );
      skipPortone = true;
    }
  }

  if (skipPortone) {
    impUid = impUid || `imp_smoke_v1_${Date.now()}`;
    const prismaLocal = new PrismaClient();
    try {
      await prismaLocal.payment.update({
        where: { orderId: merchantId },
        data: {
          paymentKey: impUid,
          method: PaymentMethod.VBANK,
          rawResponse: buildV1LocalVaSnapshot(reqParams.totalAmount!, impUid) as object,
        },
      });
    } finally {
      await prismaLocal.$disconnect();
    }
    record('portone.va-issue', true, `(local fixture imp_uid=${impUid})`);
  } else if (impUid) {
    record('portone.va-issue', true, `using imp_uid=${impUid}`);
  }

  const confirmRes = await apiRaw('/payment/confirm', {
    method: 'POST',
    token,
    body: JSON.stringify({ paymentId: impUid, merchantId }),
  });
  if (!confirmRes.ok) {
    record('payment.confirm', false, `HTTP ${confirmRes.status} ${formatHttpBody(confirmRes.body)}`);
    failWithReport(`ROOT CAUSE: /payment/confirm failed`);
  }
  const confirmed = confirmRes.body as { ok?: boolean; status?: string; vbankNum?: string };
  if (!confirmed.ok || !confirmed.status || !['VA_ISSUED', 'PAID'].includes(confirmed.status)) {
    record('payment.confirm', false, JSON.stringify(confirmed).slice(0, 200));
    failWithReport('ROOT CAUSE: Unexpected confirm body');
  }
  record(
    'payment.confirm',
    true,
    `status=${confirmed.status}${confirmed.vbankNum ? ` vbank=${confirmed.vbankNum}` : ''}`,
  );

  const prisma = new PrismaClient();
  try {
    const row = await prisma.payment.findUnique({ where: { orderId: merchantId } });
    if (!row?.paymentKey) {
      record('db.payment', false, 'payment_key empty');
      failWithReport('ROOT CAUSE: DB payment_key not set');
    }
    record('db.payment', true, `status=${row.status} payment_key=${row.paymentKey.slice(0, 20)}…`);
  } finally {
    await prisma.$disconnect();
  }

  console.log('\n== PortOne V1 smoke passed ==');
  if (skipPortone && MODE !== 'local') {
    console.log('(used local fixture — run browser VA + SMOKE_V1_IMP_UID for full PG path)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

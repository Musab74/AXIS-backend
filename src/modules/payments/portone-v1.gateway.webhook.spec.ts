import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { PortoneV1Gateway } from './portone-v1.gateway';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SECRET = 'test-imp-secret';

function makeConfig(secret: string | null = SECRET): ConfigService {
  const map: Record<string, string | undefined> = {
    'portone.v1ImpSecret': secret ?? undefined,
    'portone.v1ApiSecret': undefined,
  };
  return {
    get: (key: string) => map[key],
  } as unknown as ConfigService;
}

function signPayload(impUid: string, status: string): string {
  return createHmac('sha256', SECRET).update(`${impUid}${status}`).digest('hex');
}

describe('PortoneV1Gateway.verifyWebhook — signature enforcement', () => {
  it('rejects webhooks with no signature header', async () => {
    const gw = new PortoneV1Gateway(makeConfig());
    const body = JSON.stringify({ imp_uid: 'imp_1', merchant_uid: 'm_1', status: 'paid' });
    await expect(gw.verifyWebhook(body, {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects webhooks with an invalid signature', async () => {
    const gw = new PortoneV1Gateway(makeConfig());
    const body = JSON.stringify({ imp_uid: 'imp_1', merchant_uid: 'm_1', status: 'paid' });
    await expect(
      gw.verifyWebhook(body, { imp_signature: 'not-a-valid-sig' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts webhooks with a matching signature and returns events', async () => {
    const gw = new PortoneV1Gateway(makeConfig());
    const body = JSON.stringify({ imp_uid: 'imp_ok', merchant_uid: 'AXIS_1', status: 'paid' });
    const events = await gw.verifyWebhook(body, {
      imp_signature: signPayload('imp_ok', 'paid'),
    });
    expect(events).toEqual([
      { type: 'PAID', merchantOrderId: 'AXIS_1', transactionId: 'imp_ok' },
    ]);
  });

  it('accepts the lowercase imp-signature header alias', async () => {
    const gw = new PortoneV1Gateway(makeConfig());
    const body = JSON.stringify({ imp_uid: 'imp_va', merchant_uid: 'AXIS_va', status: 'ready' });
    const events = await gw.verifyWebhook(body, {
      'imp-signature': signPayload('imp_va', 'ready'),
    });
    expect(events).toEqual([
      { type: 'VA_ISSUED', merchantOrderId: 'AXIS_va', transactionId: 'imp_va' },
    ]);
  });

  it('rejects when no imp secret is configured (fails closed)', async () => {
    const gw = new PortoneV1Gateway(makeConfig(null));
    const body = JSON.stringify({ imp_uid: 'imp_1', merchant_uid: 'm_1', status: 'paid' });
    await expect(
      gw.verifyWebhook(body, { imp_signature: 'anything' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

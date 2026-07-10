import type { ConfigService } from '@nestjs/config';
import { PortoneV1Gateway } from './portone-v1.gateway';

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeConfig(): ConfigService {
  return { get: () => undefined } as unknown as ConfigService;
}

/**
 * iamport V1 webhooks are NOT signed — verifyWebhook only parses the body
 * into untrusted hint events. The security boundary is downstream:
 * PortoneApplyService.reconcileFromRemote re-fetches every payment from the
 * PG API and applies only the API-reported state (tested in
 * portone-apply.service.spec.ts).
 */
describe('PortoneV1Gateway.verifyWebhook — untrusted-trigger parsing', () => {
  const gw = () => new PortoneV1Gateway(makeConfig());

  it('parses a JSON body into a PAID hint event', async () => {
    const body = JSON.stringify({ imp_uid: 'imp_1', merchant_uid: 'AXIS-r1-1', status: 'paid' });
    await expect(gw().verifyWebhook(body, {})).resolves.toEqual([
      { type: 'PAID', merchantOrderId: 'AXIS-r1-1', transactionId: 'imp_1' },
    ]);
  });

  it('parses application/x-www-form-urlencoded bodies (older console config)', async () => {
    const body = 'imp_uid=imp_2&merchant_uid=AXIS-r2-1&status=ready';
    await expect(gw().verifyWebhook(body, {})).resolves.toEqual([
      { type: 'VA_ISSUED', merchantOrderId: 'AXIS-r2-1', transactionId: 'imp_2' },
    ]);
  });

  it('maps cancelled and failed statuses and keeps imp_uid as transactionId', async () => {
    const cancelled = JSON.stringify({ imp_uid: 'imp_3', merchant_uid: 'm_3', status: 'cancelled' });
    await expect(gw().verifyWebhook(cancelled, {})).resolves.toEqual([
      { type: 'CANCELLED', merchantOrderId: 'm_3', transactionId: 'imp_3' },
    ]);
    const failed = JSON.stringify({ imp_uid: 'imp_4', merchant_uid: 'm_4', status: 'failed' });
    await expect(gw().verifyWebhook(failed, {})).resolves.toEqual([
      { type: 'FAILED', merchantOrderId: 'm_4', transactionId: 'imp_4' },
    ]);
  });

  it('falls back to imp_uid when merchant_uid is missing', async () => {
    const body = JSON.stringify({ imp_uid: 'imp_5', status: 'paid' });
    await expect(gw().verifyWebhook(body, {})).resolves.toEqual([
      { type: 'PAID', merchantOrderId: 'imp_5', transactionId: 'imp_5' },
    ]);
  });

  it('returns [] for unparseable, empty, or incomplete bodies', async () => {
    await expect(gw().verifyWebhook('{not json', {})).resolves.toEqual([]);
    await expect(gw().verifyWebhook('', {})).resolves.toEqual([]);
    await expect(
      gw().verifyWebhook(JSON.stringify({ merchant_uid: 'm_1' }), {}),
    ).resolves.toEqual([]);
    await expect(
      gw().verifyWebhook(JSON.stringify({ imp_uid: 'imp_1' }), {}),
    ).resolves.toEqual([]);
  });

  it('ignores unknown statuses', async () => {
    const body = JSON.stringify({ imp_uid: 'imp_6', merchant_uid: 'm_6', status: 'chargeback' });
    await expect(gw().verifyWebhook(body, {})).resolves.toEqual([]);
  });
});

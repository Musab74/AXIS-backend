import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PortonePaymentLike } from './portone-payment.types';
import {
  NormalizedWebhookEvent,
  PortoneGateway,
  PortoneModuleVersion,
} from './portone-gateway.interface';
import { PortoneV1Client } from './portone-v1.client';
import { iamportPaymentToPortoneLike } from './portone-v1-normalize';

type V1WebhookPayload = {
  imp_uid?: string;
  merchant_uid?: string;
  status?: string;
};

/**
 * iamport V1 webhook bodies arrive as JSON or application/x-www-form-urlencoded
 * depending on the console configuration — handle both.
 */
function parseV1WebhookBody(rawBody: string): V1WebhookPayload | null {
  const trimmed = rawBody.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as V1WebhookPayload;
    } catch {
      return null;
    }
  }
  const params = new URLSearchParams(trimmed);
  const imp_uid = params.get('imp_uid') ?? undefined;
  const merchant_uid = params.get('merchant_uid') ?? undefined;
  const status = params.get('status') ?? undefined;
  if (!imp_uid && !status) return null;
  return { imp_uid, merchant_uid, status };
}

@Injectable()
export class PortoneV1Gateway implements PortoneGateway {
  readonly version: PortoneModuleVersion = 'v1';
  private readonly logger = new Logger(PortoneV1Gateway.name);
  private client: PortoneV1Client | null = null;

  constructor(private readonly config: ConfigService) {}

  private credentials(): PortoneV1Client {
    if (this.client) return this.client;
    const impKey =
      this.config.get<string>('portone.v1ImpKey')?.trim() ||
      this.config.get<string>('portone.v1ApiKey')?.trim() ||
      '';
    const impSecret =
      this.config.get<string>('portone.v1ImpSecret')?.trim() ||
      this.config.get<string>('portone.v1ApiSecret')?.trim() ||
      '';
    if (!impKey || !impSecret) {
      throw new BadRequestException(
        'PortOne V1 is not configured (PORTONE_V1_IMP_KEY + PORTONE_V1_IMP_SECRET)',
      );
    }
    this.client = new PortoneV1Client(impKey, impSecret);
    return this.client;
  }

  async getPayment(remoteRef: string): Promise<PortonePaymentLike> {
    const row = await this.credentials().getPaymentByImpUid(remoteRef);
    return iamportPaymentToPortoneLike(row);
  }

  async getPaymentByMerchantOrderId(merchantOrderId: string): Promise<PortonePaymentLike | null> {
    const row = await this.credentials().findPaymentByMerchantUid(merchantOrderId);
    return row ? iamportPaymentToPortoneLike(row) : null;
  }

  async findReadyByMerchantUid(merchantUid: string): Promise<PortonePaymentLike | null> {
    const row = await this.credentials().findPaymentByMerchantUid(merchantUid, 'ready');
    if (!row) return null;
    return iamportPaymentToPortoneLike(row);
  }

  async probeCredentials(): Promise<{ ok: boolean; detail: string }> {
    return this.credentials().probeCredentials();
  }

  async cancelPayment(remoteRef: string, reason: string, amount?: number): Promise<void> {
    await this.credentials().cancelPayment({
      impUid: remoteRef,
      amount,
      reason,
    });
  }

  /**
   * SECURITY MODEL — iamport V1 webhooks are NOT signed. There is no
   * imp_signature/HMAC header in the real service; iamport's documented
   * integrity model is server-side re-verification:
   *   1. The webhook body is treated strictly as an untrusted trigger
   *      carrying identifiers (imp_uid / merchant_uid).
   *   2. PortoneApplyService.reconcileFromRemote re-fetches the payment from
   *      api.iamport.kr over TLS and acts ONLY on the API-reported
   *      status/amount — a spoofed body can trigger nothing the PG does not
   *      itself confirm.
   *   3. Optional defence-in-depth: set PORTONE_WEBHOOK_ALLOWED_IPS to pin
   *      iamport's documented webhook source IPs (52.78.100.19,
   *      52.78.48.223, 52.78.5.241) at the controller.
   */
  async verifyWebhook(
    rawBody: string,
    _headers: Record<string, string | string[] | undefined>,
  ): Promise<NormalizedWebhookEvent[]> {
    const payload = parseV1WebhookBody(rawBody);
    if (!payload) {
      this.logger.warn('PortOne V1 webhook: unparseable body');
      return [];
    }

    const impUid = payload.imp_uid?.trim();
    const status = payload.status?.trim();
    if (!impUid || !status) return [];
    const merchantUid = payload.merchant_uid?.trim() || impUid;

    switch (status) {
      case 'paid':
        return [{ type: 'PAID', merchantOrderId: merchantUid, transactionId: impUid }];
      case 'ready':
        return [{ type: 'VA_ISSUED', merchantOrderId: merchantUid, transactionId: impUid }];
      case 'cancelled':
        return [{ type: 'CANCELLED', merchantOrderId: merchantUid, transactionId: impUid }];
      case 'failed':
        return [{ type: 'FAILED', merchantOrderId: merchantUid, transactionId: impUid }];
      default:
        this.logger.warn(`PortOne V1 webhook: ignored status=${status}`);
        return [];
    }
  }
}

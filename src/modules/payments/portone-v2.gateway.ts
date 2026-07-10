import { Injectable, Logger } from '@nestjs/common';
import { PortoneWebhookSecretService } from '../../config/portone-webhook-secret.loader';
import type { PortonePaymentLike } from './portone-payment.types';
import {
  NormalizedWebhookEvent,
  PortoneGateway,
  PortoneModuleVersion,
} from './portone-gateway.interface';
import { PortoneVerifyService } from './portone-verify.service';

@Injectable()
export class PortoneV2Gateway implements PortoneGateway {
  readonly version: PortoneModuleVersion = 'v2';
  private readonly logger = new Logger(PortoneV2Gateway.name);

  constructor(
    private readonly verify: PortoneVerifyService,
    private readonly webhookSecret: PortoneWebhookSecretService,
  ) {}

  getPayment(remoteRef: string): Promise<PortonePaymentLike> {
    return this.verify.getPayment(remoteRef);
  }

  /** V2 paymentId IS the merchant-side order id, so this is a plain lookup. */
  async getPaymentByMerchantOrderId(merchantOrderId: string): Promise<PortonePaymentLike | null> {
    try {
      return await this.verify.getPayment(merchantOrderId);
    } catch {
      return null;
    }
  }

  async cancelPayment(remoteRef: string, reason: string, amount?: number): Promise<void> {
    await this.verify.cancelPayment(remoteRef, reason, amount);
  }

  async verifyWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<NormalizedWebhookEvent[]> {
    const secret = await this.webhookSecret.getSecret();
    const { verify } = (await import('@portone/server-sdk/dist/webhook.cjs')) as {
      verify: (
        s: string | Uint8Array,
        payload: string,
        h: Record<string, string | string[] | undefined>,
      ) => Promise<unknown>;
    };

    const wh = await verify(secret, rawBody, { ...headers });
    const eventType = (wh as { type?: string }).type;
    const status = (wh as { status?: string }).status;
    const data = (wh as { data?: { paymentId?: string; transactionId?: string } }).data;

    if (!data?.paymentId) return [];
    const merchantOrderId = data.paymentId;
    const transactionId = data.transactionId ?? data.paymentId;

    if (eventType === 'Transaction.Paid' || status === 'paid') {
      return [{ type: 'PAID', merchantOrderId, transactionId }];
    }
    if (eventType === 'Transaction.VirtualAccountIssued' || status === 'virtual_account_issued') {
      return [{ type: 'VA_ISSUED', merchantOrderId, transactionId }];
    }
    if (eventType === 'Transaction.Cancelled' || status === 'cancelled') {
      return [{ type: 'CANCELLED', merchantOrderId, transactionId }];
    }
    if (eventType === 'Transaction.Failed') {
      return [{ type: 'FAILED', merchantOrderId, transactionId }];
    }

    this.logger.warn(`PortOne V2 webhook: ignored event ${String(eventType ?? status)}`);
    return [];
  }
}

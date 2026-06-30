import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import type { PortonePaymentLike } from './portone-payment.types';
import {
  NormalizedWebhookEvent,
  PortoneGateway,
  PortoneModuleVersion,
} from './portone-gateway.interface';
import { PortoneV1Client } from './portone-v1.client';
import { iamportPaymentToPortoneLike } from './portone-v1-normalize';

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

  async verifyWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<NormalizedWebhookEvent[]> {
    const impSecret =
      this.config.get<string>('portone.v1ImpSecret')?.trim() ||
      this.config.get<string>('portone.v1ApiSecret')?.trim() ||
      '';
    let payload: {
      imp_uid?: string;
      merchant_uid?: string;
      status?: string;
    };
    try {
      payload = JSON.parse(rawBody) as typeof payload;
    } catch {
      this.logger.warn('PortOne V1 webhook: invalid JSON');
      return [];
    }

    const impUid = payload.imp_uid;
    const merchantUid = payload.merchant_uid ?? impUid ?? '';
    const status = payload.status;
    if (!impUid || !status) return [];

    const signature = headers['imp_signature'] ?? headers['Imp-Signature'];
    const sig = Array.isArray(signature) ? signature[0] : signature;
    if (impSecret && sig) {
      const expected = createHmac('sha256', impSecret)
        .update(`${impUid}${status}`)
        .digest('hex');
      if (expected !== sig) {
        throw new BadRequestException('Invalid PortOne V1 webhook signature');
      }
    }

    if (status === 'paid') {
      return [{ type: 'PAID', merchantOrderId: merchantUid, transactionId: impUid }];
    }
    if (status === 'ready') {
      return [{ type: 'VA_ISSUED', merchantOrderId: merchantUid, transactionId: impUid }];
    }
    if (status === 'cancelled') {
      return [{ type: 'CANCELLED', merchantOrderId: merchantUid }];
    }
    if (status === 'failed') {
      return [{ type: 'FAILED', merchantOrderId: merchantUid }];
    }
    return [];
  }
}

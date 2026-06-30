import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PortOneClient } from '@portone/server-sdk';
import type { PortonePaymentLike } from './portone-payment.types';

@Injectable()
export class PortoneVerifyService {
  constructor(private readonly config: ConfigService) {}

  private client() {
    const secret = this.config.get<string>('portone.v2ApiSecret') ?? '';
    const storeId = this.config.get<string>('portone.storeId') ?? '';
    if (!secret.trim()) {
      throw new BadRequestException('PortOne API is not configured');
    }
    return PortOneClient({ secret: secret.trim(), storeId: storeId.trim() || undefined });
  }

  private storeId(): string | undefined {
    const storeId = this.config.get<string>('portone.storeId')?.trim();
    return storeId || undefined;
  }

  async getPayment(paymentId: string): Promise<PortonePaymentLike> {
    const client = this.client();
    return (await client.payment.getPayment({
      paymentId,
      storeId: this.storeId(),
    })) as unknown as PortonePaymentLike;
  }

  async cancelPayment(paymentId: string, reason: string, amount?: number) {
    const client = this.client();
    return client.payment.cancelPayment({
      paymentId,
      storeId: this.storeId(),
      reason,
      ...(amount !== undefined ? { amount } : {}),
    });
  }
}

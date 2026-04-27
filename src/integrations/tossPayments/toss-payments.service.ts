import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { TossApiError, TossErrorBody, TossPaymentResponse } from './toss-payments.types';

const REQUEST_TIMEOUT_MS = 10_000;

@Injectable()
export class TossPaymentsService implements OnModuleInit {
  private readonly logger = new Logger(TossPaymentsService.name);
  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;
  private readonly authHeader: string;
  readonly isTestMode: boolean;

  constructor(private readonly config: ConfigService) {
    this.secretKey = this.config.getOrThrow<string>('toss.secretKey');
    this.webhookSecret = this.config.getOrThrow<string>('toss.webhookSecret');
    this.baseUrl = this.config.getOrThrow<string>('toss.apiBaseUrl').replace(/\/$/, '');
    this.isTestMode = !!this.config.get<boolean>('toss.isTestMode');
    // Toss uses HTTP Basic with secret key as username and an empty password.
    this.authHeader =
      'Basic ' + Buffer.from(`${this.secretKey}:`, 'utf8').toString('base64');
  }

  onModuleInit() {
    this.logger.log(
      `Toss Payments initialized [mode=${this.isTestMode ? 'TEST' : 'LIVE'}] [keyTail=${this.maskKey(this.secretKey)}]`,
    );
  }

  /**
   * Confirm a payment after the user is redirected back from Toss.
   * MUST be called with the server-side trusted amount (not the client's claim).
   * Idempotent on Toss side per (paymentKey, orderId, amount); we still guard at DB.
   */
  async confirmPayment(input: {
    paymentKey: string;
    orderId: string;
    amount: number;
  }): Promise<TossPaymentResponse> {
    return this.request<TossPaymentResponse>('POST', '/v1/payments/confirm', {
      paymentKey: input.paymentKey,
      orderId: input.orderId,
      amount: input.amount,
    });
  }

  async cancelPayment(
    paymentKey: string,
    cancelReason: string,
    cancelAmount?: number,
  ): Promise<TossPaymentResponse> {
    const body: Record<string, unknown> = { cancelReason };
    if (typeof cancelAmount === 'number') body.cancelAmount = cancelAmount;
    return this.request<TossPaymentResponse>(
      'POST',
      `/v1/payments/${encodeURIComponent(paymentKey)}/cancel`,
      body,
    );
  }

  async getPayment(paymentKey: string): Promise<TossPaymentResponse> {
    return this.request<TossPaymentResponse>(
      'GET',
      `/v1/payments/${encodeURIComponent(paymentKey)}`,
    );
  }

  /**
   * Verify webhook signature using HMAC-SHA256 with timing-safe comparison.
   * Caller MUST pass the raw request body (Buffer or exact bytes), not a re-stringified object,
   * because JSON whitespace/key-order changes break HMAC.
   */
  verifyWebhookSignature(rawBody: Buffer | string, headerSignature: string | undefined): boolean {
    if (!headerSignature || typeof headerSignature !== 'string') return false;
    const computed = createHmac('sha256', this.webhookSecret)
      .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
      .digest('hex');

    const a = Buffer.from(computed, 'utf8');
    const b = Buffer.from(headerSignature.trim(), 'utf8');
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
          // Idempotency-Key would go here on retried calls. We don't auto-retry confirms.
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'unknown';
      // Never include the auth header or secret in logs.
      this.logger.error(`Toss network error path=${path} reason=${message}`);
      throw new TossApiError(0, 'NETWORK_ERROR', 'Toss API network error');
    } finally {
      clearTimeout(timeout);
    }

    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      /* fall through */
    }

    if (!res.ok) {
      const err = (parsed as TossErrorBody) ?? { code: 'UNKNOWN', message: 'Unknown error' };
      this.logger.warn(
        `Toss API error path=${path} status=${res.status} code=${err.code}`,
      );
      throw new TossApiError(res.status, err.code, err.message, parsed);
    }

    return parsed as T;
  }

  private maskKey(key: string): string {
    if (!key || key.length < 8) return '***';
    return `${key.slice(0, 8)}...${key.slice(-4)}`;
  }
}

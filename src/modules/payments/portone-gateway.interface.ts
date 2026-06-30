import type { PortonePaymentLike } from './portone-payment.types';

export type PortoneModuleVersion = 'v1' | 'v2';

export const PORTONE_GATEWAY = 'PORTONE_GATEWAY';

export type NormalizedWebhookEvent =
  | { type: 'PAID'; merchantOrderId: string; transactionId: string }
  | { type: 'VA_ISSUED'; merchantOrderId: string; transactionId: string }
  | { type: 'CANCELLED'; merchantOrderId: string }
  | { type: 'FAILED'; merchantOrderId: string };

export interface PortoneGateway {
  readonly version: PortoneModuleVersion;
  getPayment(remoteRef: string): Promise<PortonePaymentLike>;
  cancelPayment(remoteRef: string, reason: string, amount?: number): Promise<void>;
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<NormalizedWebhookEvent[]>;
}

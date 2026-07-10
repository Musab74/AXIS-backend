import type { PortonePaymentLike } from './portone-payment.types';

export type PortoneModuleVersion = 'v1' | 'v2';

export const PORTONE_GATEWAY = 'PORTONE_GATEWAY';

export type NormalizedWebhookEventType = 'PAID' | 'VA_ISSUED' | 'CANCELLED' | 'FAILED';

/**
 * Webhook events are UNTRUSTED HINTS: they carry identifiers only. The
 * consumer (PortoneApplyService.reconcileFromRemote) must re-fetch the payment
 * from the PG API and act on the API-reported status/amount — never on the
 * webhook-claimed type. This keeps spoofed webhooks harmless even when the
 * PG (iamport V1) does not sign its callbacks.
 */
export interface NormalizedWebhookEvent {
  type: NormalizedWebhookEventType;
  merchantOrderId: string;
  transactionId: string;
}

export interface PortoneGateway {
  readonly version: PortoneModuleVersion;
  getPayment(remoteRef: string): Promise<PortonePaymentLike>;
  cancelPayment(remoteRef: string, reason: string, amount?: number): Promise<void>;
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<NormalizedWebhookEvent[]>;
  /** Look up by OUR order id (V1 merchant_uid / V2 paymentId). Null when not found. */
  getPaymentByMerchantOrderId?(merchantOrderId: string): Promise<PortonePaymentLike | null>;
  /** Cheap credential sanity check, surfaced at boot by PaymentsReconciliationService. */
  probeCredentials?(): Promise<{ ok: boolean; detail: string }>;
}

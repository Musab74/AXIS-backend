import { BadRequestException } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { bankEnumToKoreanLabel } from './portone-va-display';

/** Narrow shape for PortOne `getPayment` success JSON (avoid SDK union resolution issues). */
export interface PortonePaymentLike {
  status?: string;
  id: string;
  amount: { total: number };
  method?: {
    type?: string;
    accountNumber?: string;
    bank?: string;
    expiredAt?: string;
    provider?: string;
  };
}

/** Map PortOne remote method → Prisma PaymentMethod (for CARD refunds without refundAccount). */
export function mapPortoneMethodToPrisma(
  method: PortonePaymentLike['method'] | undefined,
): PaymentMethod {
  const type = method && typeof method === 'object' ? method.type : undefined;
  switch (type) {
    case 'PaymentMethodVirtualAccount':
      return PaymentMethod.VBANK;
    case 'PaymentMethodTransfer':
      return PaymentMethod.TRANSFER;
    case 'PaymentMethodEasyPay': {
      const provider = (method?.provider ?? '').toUpperCase();
      if (provider.includes('KAKAO')) return PaymentMethod.KAKAOPAY;
      if (provider.includes('NAVER')) return PaymentMethod.NAVERPAY;
      if (provider.includes('TOSS')) return PaymentMethod.TOSSPAY;
      return PaymentMethod.CARD;
    }
    case 'PaymentMethodCard':
    default:
      return PaymentMethod.CARD;
  }
}

export const PORTONE_ISSUABLE = new Set(['VIRTUAL_ACCOUNT_ISSUED', 'PAID']);

export function isVirtualAccountMethod(
  m: PortonePaymentLike['method'],
): m is { type: 'PaymentMethodVirtualAccount'; accountNumber: string; bank?: string; expiredAt?: string } {
  return !!m && typeof m === 'object' && (m as { type?: string }).type === 'PaymentMethodVirtualAccount';
}

export function extractVaFromPayment(
  payment: PortonePaymentLike,
): { vbankName: string; vbankNum: string; vbankExpiry: string } {
  const status = payment.status;
  if (status !== 'VIRTUAL_ACCOUNT_ISSUED' && status !== 'PAID') {
    throw new BadRequestException(`Unexpected PortOne payment status: ${String(status)}`);
  }
  const method = payment.method;
  if (!isVirtualAccountMethod(method)) {
    throw new BadRequestException('PortOne payment has no virtual account method');
  }
  return {
    vbankName: bankEnumToKoreanLabel(method.bank),
    vbankNum: method.accountNumber,
    vbankExpiry: method.expiredAt ?? '',
  };
}

export function portoneAmountTotal(payment: PortonePaymentLike): number {
  const a = payment.amount;
  if (!a || typeof a.total !== 'number') {
    throw new BadRequestException('PortOne payment missing amount.total');
  }
  return a.total;
}

export function getPortoneRemotePaymentId(payment: PortonePaymentLike): string {
  return payment.id;
}

/** Synthetic keys from POST /payment/test-confirm — never call PortOne cancel/get on these. */
export function isDemoPaymentKey(paymentKey: string | null | undefined): boolean {
  return typeof paymentKey === 'string' && paymentKey.startsWith('DEMO-');
}

/** True when rawResponse was written by applyPaymentTestConfirm. */
export function isDemoPaymentRaw(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && (raw as { demo?: unknown }).demo === true;
}

/** Combined check used by admin APIs and refund guards. */
export function isDemoPayment(p: {
  paymentKey?: string | null;
  rawResponse?: unknown;
}): boolean {
  return isDemoPaymentKey(p.paymentKey) || isDemoPaymentRaw(p.rawResponse);
}

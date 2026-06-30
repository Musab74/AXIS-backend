import { BadRequestException } from '@nestjs/common';
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
  };
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

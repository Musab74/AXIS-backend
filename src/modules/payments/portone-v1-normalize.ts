import type { PortonePaymentLike } from './portone-payment.types';
import type { IamportPaymentRow } from './portone-v1.client';

/** KCP/Iamport vbank_code → label key used in portone-va-display. */
const VBANK_CODE_LABEL: Record<string, string> = {
  '04': 'KOOKMIN',
  '88': 'SHINHAN',
  '20': 'WOORI',
  '81': 'HANA',
  '03': 'IBK',
  '11': 'NONGHYUP',
  '90': 'KAKAO',
  '92': 'TOSS',
};

function mapV1Status(status: string): string {
  if (status === 'paid') return 'PAID';
  if (status === 'ready') return 'VIRTUAL_ACCOUNT_ISSUED';
  if (status === 'cancelled') return 'CANCELLED';
  if (status === 'failed') return 'FAILED';
  return status.toUpperCase();
}

function vbankExpiryIso(vbankDate?: number): string {
  if (!vbankDate) return '';
  const ms = vbankDate < 1_000_000_000_000 ? vbankDate * 1000 : vbankDate;
  return new Date(ms).toISOString();
}

export function iamportPaymentToPortoneLike(row: IamportPaymentRow): PortonePaymentLike {
  const bankKey =
    (row.vbank_code && VBANK_CODE_LABEL[row.vbank_code]) ||
    row.vbank_name?.replace(/\s/g, '_').toUpperCase() ||
    'KOOKMIN';

  return {
    id: row.imp_uid,
    status: mapV1Status(row.status),
    amount: { total: row.amount },
    method:
      row.pay_method === 'vbank' || row.vbank_num
        ? {
            type: 'PaymentMethodVirtualAccount',
            accountNumber: row.vbank_num ?? '',
            bank: bankKey,
            expiredAt: vbankExpiryIso(row.vbank_date),
          }
        : undefined,
  };
}

export function buildV1LocalVaSnapshot(total: number, impUid: string): PortonePaymentLike {
  const expiredAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
  return {
    id: impUid,
    status: 'VIRTUAL_ACCOUNT_ISSUED',
    amount: { total },
    method: {
      type: 'PaymentMethodVirtualAccount',
      accountNumber: '12345678901234',
      bank: 'KOOKMIN',
      expiredAt,
    },
  };
}

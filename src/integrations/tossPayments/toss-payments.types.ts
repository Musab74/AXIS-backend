export type TossPaymentMethod =
  | '카드'
  | '가상계좌'
  | '계좌이체'
  | '휴대폰'
  | '간편결제'
  | string;

export interface TossPaymentResponse {
  paymentKey: string;
  orderId: string;
  orderName: string;
  status: 'READY' | 'IN_PROGRESS' | 'WAITING_FOR_DEPOSIT' | 'DONE' | 'CANCELED' | 'PARTIAL_CANCELED' | 'ABORTED' | 'EXPIRED';
  totalAmount: number;
  balanceAmount: number;
  method: TossPaymentMethod;
  approvedAt?: string;
  requestedAt: string;
  [key: string]: unknown;
}

export interface TossErrorBody {
  code: string;
  message: string;
  data?: unknown;
}

export class TossApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'TossApiError';
  }
}

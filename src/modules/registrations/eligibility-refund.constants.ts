/** Redis keys for AXIS-C L1 candidate refund requests (admin approval queue). */
export const ELIG_REFUND_QUEUE_KEY = 'axis:elig-refund:queue';

export function eligRefundDetailKey(registrationId: string): string {
  return `axis:elig-refund:detail:${registrationId}`;
}

export type EligibilityRefundRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface EligibilityRefundRequestRecord {
  registrationId: string;
  userId: string;
  userName: string;
  userEmail: string | null;
  certType: string;
  level: string;
  roundNumber: number;
  examDate: string;
  amount: number;
  eligibilityStatus: string;
  eligibilityNote: string | null;
  requestedAt: string;
  status: EligibilityRefundRequestStatus;
  candidateNote?: string;
  processedAt?: string;
  processedBy?: string;
  adminNote?: string;
}

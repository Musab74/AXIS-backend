import { RegistrationStatus } from '@prisma/client';

/** Must match product policy — used by registrations + payment flows. */
export const SEAT_HOLD_MINUTES = 30;

/**
 * PENDING_PAYMENT is expired when `seatHeldUntil` is in the past, or when it
 * was never set (legacy/seed rows) and `createdAt` is older than the hold window.
 */
export function isPendingPaymentHoldExpired(reg: {
  status: RegistrationStatus;
  seatHeldUntil: Date | null;
  createdAt: Date;
}, now: Date = new Date()): boolean {
  if (reg.status !== RegistrationStatus.PENDING_PAYMENT) return false;
  const holdMs = SEAT_HOLD_MINUTES * 60_000;
  if (reg.seatHeldUntil) return reg.seatHeldUntil.getTime() < now.getTime();
  return reg.createdAt.getTime() < now.getTime() - holdMs;
}

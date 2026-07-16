import { IsOptional, IsString, IsEnum, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { CertLevel, CertType } from '@prisma/client';

/**
 * Logical exam-status filter values exposed to the admin UI. The service maps
 * these to the appropriate combination of `Registration.status` and
 * `ExamSession.status` (+ `passed` / certificate presence).
 *
 * NOT_STARTED   = paid but no session yet, or session in CREATED
 * IN_PROGRESS   = session.status = IN_PROGRESS
 * SUBMITTED     = session.status = SUBMITTED
 * TERMINATED    = session.status = TERMINATED
 * GRADED_PASSED = session.status = GRADED + passed = true
 * GRADED_FAILED = session.status = GRADED + passed = false
 * CERTIFIED     = a certificate row exists for the session
 * PENDING_PAYMENT / CANCELLED / REFUNDED = registration.status mirror
 */
export const ExamineeStatusValues = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'SUBMITTED',
  'TERMINATED',
  'GRADED_PASSED',
  'GRADED_FAILED',
  'CERTIFIED',
  'PENDING_PAYMENT',
  'CANCELLED',
  'REFUNDED',
] as const;
export type ExamineeStatus = (typeof ExamineeStatusValues)[number];

/**
 * Payment-oriented filters for the Registrations & Payments admin page.
 * Mapped to registration.status groups (not raw PaymentStatus rows) so
 * cancelled+pending-VBANK rows do not appear under "결제 대기".
 */
export const PaymentStatusFilterValues = ['PENDING', 'CONFIRMED', 'REFUNDED'] as const;
export type PaymentStatusFilter = (typeof PaymentStatusFilterValues)[number];

export class SearchExamineesDto {
  /** Free-text search: name, phone, email, or registration number (contains). */
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsEnum(ExamineeStatusValues)
  status?: ExamineeStatus;

  /** Prefer this over `status` on the registrations/payments screen. */
  @IsOptional()
  @IsEnum(PaymentStatusFilterValues)
  paymentStatus?: PaymentStatusFilter;

  @IsOptional()
  @IsEnum(CertType)
  certType?: CertType;

  @IsOptional()
  @IsEnum(CertLevel)
  level?: CertLevel;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

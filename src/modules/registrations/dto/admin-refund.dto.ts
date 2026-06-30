import { IsEnum, IsString, MinLength } from 'class-validator';

export const AdminRefundModeValues = ['TIERED', 'FULL'] as const;
export type AdminRefundMode = (typeof AdminRefundModeValues)[number];

/**
 * Body for `POST /admin/registrations/:id/refund`.
 *
 * `mode = 'TIERED'` mirrors the user-side {@link RegistrationsService.cancelWithRefund}
 * tiered policy (100% before reg-end, 50% within 7 days of exam, 0% inside the
 * 7-day window). `mode = 'FULL'` overrides the policy and refunds 100% of the
 * confirmed payment regardless of timing — used by SUPER_ADMIN / EXAM_ADMIN
 * for goodwill cases. Both modes require a non-empty `reason`.
 */
export class AdminRefundDto {
  @IsEnum(AdminRefundModeValues)
  mode!: AdminRefundMode;

  @IsString()
  @MinLength(1, { message: 'reason must not be empty' })
  reason!: string;
}

import { ForbiddenException } from '@nestjs/common';
import { RegistrationStatus } from '@prisma/client';
import type { PrismaService } from '../../common/prisma.service';

const BLOCKED_STATUSES: readonly RegistrationStatus[] = [
  RegistrationStatus.CANCELLED,
  RegistrationStatus.REFUNDED,
  RegistrationStatus.PENDING_PAYMENT,
];

/**
 * Guard exam-facing endpoints against acting on a session whose paid
 * registration has since been cancelled or refunded (or is not yet paid).
 * Legacy sessions with no linked registration and admin-created sessions
 * both pass through — nothing to block.
 */
export async function assertRegistrationActiveForSession(
  prisma: PrismaService,
  registrationId: string | null | undefined,
): Promise<void> {
  if (!registrationId) return;
  const reg = await prisma.registration.findUnique({
    where: { id: registrationId },
    select: { status: true },
  });
  if (!reg) return;
  if ((BLOCKED_STATUSES as RegistrationStatus[]).includes(reg.status)) {
    throw new ForbiddenException(
      reg.status === RegistrationStatus.REFUNDED
        ? '환불된 결제 건이므로 시험을 이용할 수 없습니다.'
        : reg.status === RegistrationStatus.CANCELLED
          ? '취소된 결제 건이므로 시험을 이용할 수 없습니다.'
          : '결제가 아직 확인되지 않은 시험입니다.',
    );
  }
}

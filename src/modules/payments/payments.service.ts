import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PaymentMethod,
  PaymentStatus,
  Prisma,
  RegistrationStatus,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../integrations/redis/redis.service';
import { AdminNotificationsService } from '../adminNotifications/admin-notifications.service';
import {
  getPortoneRemotePaymentId,
  portoneAmountTotal,
  type PortonePaymentLike,
} from './portone-payment.types';

export type RemoteStateOutcome = 'PAID' | 'VA_ISSUED' | 'CANCELLED' | 'FAILED' | 'SKIPPED';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly adminNotifications: AdminNotificationsService,
  ) {}

  /**
   * Single money-path for every asynchronous PG signal (webhook AND the
   * reconciliation cron): apply whatever state the PG API actually reports.
   * `remote` MUST come from a server-side PG API fetch — never from a webhook
   * body — so a spoofed webhook can only trigger a lookup, not a state change.
   */
  async applyRemoteState(
    local: { orderId: string; amount: number },
    remote: PortonePaymentLike,
  ): Promise<RemoteStateOutcome> {
    const remoteId = getPortoneRemotePaymentId(remote);
    switch (remote.status) {
      case 'PAID': {
        let total: number;
        try {
          total = portoneAmountTotal(remote);
        } catch {
          this.logger.error(`PortOne remote payment missing amount.total order=${local.orderId}`);
          return 'SKIPPED';
        }
        if (total !== local.amount) {
          this.logger.error(
            `PortOne amount mismatch order=${local.orderId} db=${local.amount} portone=${total}`,
          );
          return 'SKIPPED';
        }
        await this.applyPortOnePaid({
          merchantId: local.orderId,
          pgPaymentId: remoteId,
          rawResponse: remote as unknown as Prisma.InputJsonValue,
        });
        return 'PAID';
      }
      case 'VIRTUAL_ACCOUNT_ISSUED':
        await this.applyPortOneVaIssued({
          merchantId: local.orderId,
          pgPaymentId: remoteId,
          rawResponse: remote as unknown as Prisma.InputJsonValue,
        });
        return 'VA_ISSUED';
      case 'CANCELLED':
      case 'PARTIAL_CANCELLED':
        await this.applyPortOneCancelled(local.orderId);
        return 'CANCELLED';
      case 'FAILED':
        await this.applyPortOneFailed(local.orderId);
        return 'FAILED';
      default:
        return 'SKIPPED';
    }
  }

  async applyPortOneVaIssued(input: {
    merchantId: string;
    pgPaymentId: string;
    rawResponse: Prisma.InputJsonValue;
  }): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { orderId: input.merchantId },
    });
    if (!payment) {
      this.logger.warn(`PortOne VA issued: unknown merchantId=${input.merchantId}`);
      return;
    }
    if (payment.status === PaymentStatus.CONFIRMED) return;
    // Idempotent: the reconciliation cron re-checks pending VA rows every
    // sweep — skip the write when nothing changed.
    if (payment.paymentKey === input.pgPaymentId && payment.rawResponse) return;

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        paymentKey: input.pgPaymentId,
        method: PaymentMethod.VBANK,
        rawResponse: input.rawResponse,
      },
    });
    this.logger.log(`PortOne VA issued persisted: order=${input.merchantId}`);
  }

  async applyPortOnePaid(input: {
    merchantId: string;
    pgPaymentId: string;
    paidAt?: Date;
    rawResponse?: Prisma.InputJsonValue;
  }): Promise<void> {
    const payment = await this.prisma.payment.findFirst({
      where: {
        OR: [
          { orderId: input.merchantId },
          { paymentKey: input.pgPaymentId },
          { orderId: input.pgPaymentId },
        ],
      },
      include: { registration: { include: { schedule: true } } },
    });
    if (!payment) {
      this.logger.warn(`PortOne paid: unknown merchantId=${input.merchantId}`);
      return;
    }
    if (payment.status === PaymentStatus.CONFIRMED) return;

    const registration = payment.registration;
    if (registration.schedule.currentCount > registration.schedule.capacity) {
      // Money was collected but the schedule is over capacity. Leave the
      // payment PENDING (the reconciliation cron retries it, so it
      // self-heals if a seat frees up) and page the admins — silence here
      // means a paid customer with no seat.
      this.logger.error(
        `PortOne paid: capacity exceeded registration=${registration.id} — payment left PENDING, admins alerted`,
      );
      await this.alertCapacityExceeded(payment.id, payment.registrationId, payment.orderId);
      return;
    }

    const daysAfterPayment = this.config.get<number>('exam.daysAfterPayment') ?? 20;
    const examDeadline = new Date(Date.now() + daysAfterPayment * 24 * 60 * 60_000);
    const approvedAt = input.paidAt ?? new Date();

    const regUpdate: Prisma.RegistrationUpdateInput = {
      status: RegistrationStatus.PAID,
      seatHeldUntil: null,
      examDeadline,
    };
    // AXIS-C L1 with uploaded doc → queue for review on payment confirm.
    if (
      registration.certType === 'AXIS_C' &&
      registration.level === 'L1' &&
      registration.supportDocUrl &&
      registration.eligibilityStatus === 'NOT_REQUIRED'
    ) {
      regUpdate.eligibilityStatus = 'PENDING';
    }

    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.CONFIRMED,
          paymentKey: input.pgPaymentId,
          method: PaymentMethod.VBANK,
          approvedAt,
          ...(input.rawResponse ? { rawResponse: input.rawResponse } : {}),
        },
      }),
      this.prisma.registration.update({
        where: { id: payment.registrationId },
        data: regUpdate,
      }),
    ]);

    this.logger.log(
      `Payment confirmed: ${input.merchantId} registration=${payment.registrationId} (notify SMS/email stub)`,
    );
  }

  async applyPortOneCancelled(merchantId: string): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { orderId: merchantId },
      include: { registration: true },
    });
    if (!payment) {
      this.logger.warn(`PortOne cancelled: unknown merchantId=${merchantId}`);
      return;
    }
    if (payment.status === PaymentStatus.CANCELLED) return;

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.CANCELLED, cancelledAt: now },
      }),
      ...(payment.registration.status === RegistrationStatus.PENDING_PAYMENT
        ? [
            this.prisma.registration.update({
              where: { id: payment.registrationId },
              data: {
                status: RegistrationStatus.CANCELLED,
                cancelledAt: now,
                seatHeldUntil: null,
              },
            }),
          ]
        : []),
    ]);

    this.logger.log(`PortOne payment cancelled: order=${merchantId}`);
  }

  async applyPortOneFailed(merchantId: string): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { orderId: merchantId },
    });
    if (!payment || payment.status !== PaymentStatus.PENDING) return;

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.CANCELLED, cancelledAt: new Date() },
    });
    this.logger.log(`PortOne payment failed → cancelled pending row: order=${merchantId}`);
  }

  private async alertCapacityExceeded(
    paymentId: string,
    registrationId: string,
    orderId: string,
  ): Promise<void> {
    // Redis-deduped: the reconciliation cron retries the PENDING payment every
    // sweep — alert once per 6h per payment, not once per sweep. When Redis is
    // down the dedupe is skipped rather than the alert (fail-open on delivery).
    const acquired = await this.redis.setNxEx(`payments:capacity-alert:${paymentId}`, 6 * 3600);
    if (!acquired && this.redis.isReady()) return;
    try {
      await this.adminNotifications.notify({
        category: 'REGISTRATION',
        force: true, // money already collected — never drop this on a muted preference
        severity: 'HIGH',
        titleKo: '입금 확인됐지만 정원 초과로 접수 미확정',
        titleEn: 'Deposit received but schedule over capacity',
        bodyKo: `주문 ${orderId} 입금이 확인되었지만 해당 회차 정원이 초과되어 접수가 확정되지 않았습니다. 정원 조정 또는 환불 처리가 필요합니다.`,
        bodyEn: `Order ${orderId} was paid but the schedule is over capacity. Adjust capacity or refund the candidate.`,
        meta: { paymentId, registrationId, orderId },
      });
    } catch (err) {
      this.logger.warn(`capacity alert failed: ${(err as Error).message}`);
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PaymentMethod,
  PaymentStatus,
  Prisma,
  RegistrationStatus,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

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
      this.logger.error(`PortOne paid: capacity exceeded registration=${registration.id}`);
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
}

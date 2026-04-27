import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { Prisma, PaymentStatus, PaymentMethod, RegistrationStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { TossPaymentsService } from '../../integrations/tossPayments/toss-payments.service';
import { TossApiError, TossPaymentResponse } from '../../integrations/tossPayments/toss-payments.types';

const ORDER_ID_PREFIX = 'AXIS';

const TOSS_TO_DOMAIN_METHOD: Record<string, PaymentMethod> = {
  카드: PaymentMethod.CARD,
  가상계좌: PaymentMethod.VBANK,
  계좌이체: PaymentMethod.TRANSFER,
  간편결제: PaymentMethod.KAKAOPAY,
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly toss: TossPaymentsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Step 1: User clicks "pay" → server creates a Payment row with the trusted amount
   * derived from the registration. Returns the data the browser SDK needs.
   *
   * The amount is NEVER taken from the client. We compute it from CertificationLevel.fee.
   */
  async ready(userId: string, registrationId: string) {
    const registration = await this.prisma.registration.findUnique({
      where: { id: registrationId },
      include: {
        schedule: true,
      },
    });
    if (!registration) throw new NotFoundException('Registration not found');
    if (registration.userId !== userId)
      throw new ForbiddenException('Not your registration');
    if (registration.status !== RegistrationStatus.PENDING_PAYMENT)
      throw new ConflictException(`Registration is in status ${registration.status}`);

    const fee = await this.resolveFee(registration.certType, registration.level);

    // Reuse an existing PENDING payment row if one is still alive — prevents
    // duplicate orders on user double-click. Idempotent issuance.
    const existing = await this.prisma.payment.findFirst({
      where: { registrationId: registration.id, status: PaymentStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return this.toReadyDto(existing.orderId, existing.amount, registration);
    }

    const orderId = this.generateOrderId();
    const created = await this.prisma.payment.create({
      data: {
        registrationId: registration.id,
        orderId,
        amount: fee,
        status: PaymentStatus.PENDING,
      },
    });

    return this.toReadyDto(created.orderId, created.amount, registration);
  }

  /**
   * Step 2: After Toss redirects success, the client posts paymentKey/orderId/amount here.
   * We:
   *   1. Look up the server-side Payment by orderId.
   *   2. Compare client-claimed amount against the stored amount (anti-tamper).
   *   3. Atomically transition PENDING → CONFIRMED with paymentKey unique constraint as a lock.
   *   4. Call Toss /confirm. On success, persist raw response. On failure, mark FAILED-equivalent.
   */
  async confirm(
    userId: string,
    input: { paymentKey: string; orderId: string; amount: number },
  ) {
    const payment = await this.prisma.payment.findUnique({
      where: { orderId: input.orderId },
      include: { registration: true },
    });
    if (!payment) throw new NotFoundException('Order not found');
    if (payment.registration.userId !== userId)
      throw new ForbiddenException('Not your order');

    if (payment.status === PaymentStatus.CONFIRMED) {
      // Idempotent re-confirm — return current state, do NOT call Toss again.
      return { status: payment.status, orderId: payment.orderId };
    }
    if (payment.status !== PaymentStatus.PENDING) {
      throw new ConflictException(`Order is in status ${payment.status}`);
    }
    if (payment.amount !== input.amount) {
      // Client tried to confirm with a different amount than the server issued. Reject hard.
      this.logger.warn(
        `Amount tamper attempt user=${userId} order=${payment.orderId} server=${payment.amount} claimed=${input.amount}`,
      );
      throw new BadRequestException('Amount mismatch');
    }

    // Reserve the paymentKey first. The unique constraint on Payment.paymentKey
    // means a concurrent confirm with the same paymentKey will fail with P2002.
    try {
      await this.prisma.payment.update({
        where: { id: payment.id, status: PaymentStatus.PENDING } as Prisma.PaymentWhereUniqueInput,
        data: { paymentKey: input.paymentKey },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('paymentKey already used');
      }
      throw err;
    }

    let tossRes: TossPaymentResponse;
    try {
      tossRes = await this.toss.confirmPayment({
        paymentKey: input.paymentKey,
        orderId: input.orderId,
        amount: input.amount,
      });
    } catch (err) {
      // Roll the row back to PENDING so user can retry; never auto-retry confirm here.
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { paymentKey: null },
      });
      if (err instanceof TossApiError) {
        throw new BadRequestException(`Toss rejected payment: ${err.code}`);
      }
      throw err;
    }

    // Cross-check Toss-returned amount + status before trusting.
    if (tossRes.status !== 'DONE' && tossRes.status !== 'WAITING_FOR_DEPOSIT') {
      throw new BadRequestException(`Unexpected Toss status: ${tossRes.status}`);
    }
    if (tossRes.totalAmount !== input.amount) {
      this.logger.error(
        `Toss returned wrong amount order=${input.orderId} expected=${input.amount} got=${tossRes.totalAmount}`,
      );
      throw new BadRequestException('Toss amount mismatch');
    }

    const finalStatus =
      tossRes.status === 'DONE' ? PaymentStatus.CONFIRMED : PaymentStatus.PENDING;

    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: finalStatus,
          method: TOSS_TO_DOMAIN_METHOD[tossRes.method] ?? null,
          approvedAt: tossRes.approvedAt ? new Date(tossRes.approvedAt) : null,
          rawResponse: tossRes as unknown as Prisma.InputJsonValue,
        },
      }),
      ...(finalStatus === PaymentStatus.CONFIRMED
        ? [
            this.prisma.registration.update({
              where: { id: payment.registrationId },
              data: { status: RegistrationStatus.PAID, seatHeldUntil: null },
            }),
          ]
        : []),
    ]);

    return { status: finalStatus, orderId: payment.orderId };
  }

  async refund(userId: string, paymentId: string, reason: string, amount?: number) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { registration: true },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.registration.userId !== userId)
      throw new ForbiddenException('Not your payment');
    if (payment.status !== PaymentStatus.CONFIRMED)
      throw new ConflictException('Only confirmed payments can be refunded');
    if (!payment.paymentKey) throw new ConflictException('Missing paymentKey');

    // Business rule (CLAUDE.md §8): no refund after exam started.
    // Implementation deferred until cbtSessions module lands; placeholder check here.

    const tossRes = await this.toss.cancelPayment(payment.paymentKey, reason, amount);

    const refundedAmount = amount ?? payment.amount;
    const newStatus =
      tossRes.balanceAmount === 0 ? PaymentStatus.REFUNDED : PaymentStatus.PARTIAL_REFUND;

    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: newStatus,
          refundAmount: refundedAmount,
          refundReason: reason,
          cancelledAt: new Date(),
          rawResponse: tossRes as unknown as Prisma.InputJsonValue,
        },
      }),
      this.prisma.registration.update({
        where: { id: payment.registrationId },
        data: {
          status:
            newStatus === PaymentStatus.REFUNDED
              ? RegistrationStatus.REFUNDED
              : RegistrationStatus.PAID,
        },
      }),
    ]);

    return { status: newStatus, refundAmount: refundedAmount };
  }

  /**
   * Toss webhook — the controller has already verified the HMAC signature.
   * We only update DB state idempotently.
   */
  async handleVerifiedWebhook(event: { eventType?: string; data?: TossPaymentResponse }) {
    const data = event?.data;
    if (!data || !data.orderId || !data.paymentKey) return;

    const payment = await this.prisma.payment.findUnique({ where: { orderId: data.orderId } });
    if (!payment) {
      this.logger.warn(`Webhook for unknown order=${data.orderId}`);
      return;
    }

    if (data.status === 'DONE' && payment.status !== PaymentStatus.CONFIRMED) {
      await this.prisma.$transaction([
        this.prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.CONFIRMED,
            paymentKey: data.paymentKey,
            approvedAt: data.approvedAt ? new Date(data.approvedAt) : new Date(),
            rawResponse: data as unknown as Prisma.InputJsonValue,
          },
        }),
        this.prisma.registration.update({
          where: { id: payment.registrationId },
          data: { status: RegistrationStatus.PAID },
        }),
      ]);
    } else if (
      (data.status === 'CANCELED' || data.status === 'PARTIAL_CANCELED') &&
      payment.status === PaymentStatus.CONFIRMED
    ) {
      const newStatus =
        data.status === 'CANCELED' ? PaymentStatus.REFUNDED : PaymentStatus.PARTIAL_REFUND;
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: newStatus, rawResponse: data as unknown as Prisma.InputJsonValue },
      });
    }
  }

  // ─────────── helpers ───────────

  private async resolveFee(certType: string, level: string): Promise<number> {
    const lvl = await this.prisma.certificationLevel.findFirst({
      where: { level: level as never, certification: { type: certType as never } },
    });
    if (!lvl) throw new NotFoundException('Certification level missing');
    return lvl.fee;
  }

  private generateOrderId(): string {
    // Server-generated, 22-char base64url, ~128 bits entropy. Unguessable.
    const rand = randomBytes(16).toString('base64url');
    return `${ORDER_ID_PREFIX}_${rand}`;
  }

  private toReadyDto(orderId: string, amount: number, registration: { certType: string; level: string }) {
    return {
      orderId,
      amount,
      currency: 'KRW',
      orderName: `AXIS ${registration.certType} ${registration.level}`,
      clientKey: this.config.getOrThrow<string>('toss.clientKey'),
      successUrl: `${this.config.getOrThrow<string>('frontendUrl')}/payments/success`,
      failUrl: `${this.config.getOrThrow<string>('frontendUrl')}/payments/fail`,
    };
  }
}

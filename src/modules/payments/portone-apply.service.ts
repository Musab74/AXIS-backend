import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PaymentStatus, RegistrationStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../integrations/redis/redis.service';
import { isPendingPaymentHoldExpired } from '../registrations/seat-hold.util';
import { PORTONE_GATEWAY, PortoneGateway, PortoneModuleVersion } from './portone-gateway.interface';
import { PaymentsService } from './payments.service';
import {
  extractVaFromPayment,
  getPortoneRemotePaymentId,
  PORTONE_ISSUABLE,
  portoneAmountTotal,
  type PortonePaymentLike,
} from './portone-payment.types';

const ORDER_TTL_SECONDS = 1800;
const PAYMENT_NETWORK_RETRY_LIMIT = 3;

/** KCP V2 (PortOne) rejects merchant order / paymentId longer than 40 chars. */
const PORTONE_ORDER_ID_MAX_LEN = 40;

/**
 * Build a merchant order id that stays within KCP V2's 40-char limit.
 * Old format `AXIS-{cuid}-{ms}` is 44 chars (5+25+1+13) and breaks the payment window.
 */
function buildPortoneMerchantOrderId(registrationId: string): string {
  const ts = Date.now().toString(36); // ~8 chars
  const rand = Math.random().toString(36).slice(2, 6);
  const reg = registrationId.replace(/[^a-zA-Z0-9]/g, '').slice(-12);
  const id = `AX${reg}${ts}${rand}`;
  return id.length <= PORTONE_ORDER_ID_MAX_LEN ? id : id.slice(0, PORTONE_ORDER_ID_MAX_LEN);
}

function needsNewPortoneOrderId(orderId: string | undefined | null): boolean {
  return !orderId || orderId.length > PORTONE_ORDER_ID_MAX_LEN;
}

async function createPendingPaymentOrReuseOnRace(
  prisma: PrismaService,
  registrationId: string,
  orderId: string,
  amount: number,
) {
  try {
    return await prisma.payment.create({
      data: {
        registrationId,
        orderId,
        amount,
        status: PaymentStatus.PENDING,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const existing = await prisma.payment.findFirst({
        where: { registrationId, status: PaymentStatus.PENDING },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) return existing;
    }
    throw e;
  }
}

function certDisplay(certType: string): string {
  if (certType === 'AXIS_C') return 'AXIS-C';
  if (certType === 'AXIS_H') return 'AXIS-H';
  return 'AXIS';
}

function levelDisplayKo(level: string): string {
  if (level === 'L1') return 'Leader';
  if (level === 'L2') return 'Practitioner';
  return 'Starter';
}

function buildOrderNameKo(certType: string, level: string): string {
  return `${certDisplay(certType)} ${levelDisplayKo(level)} 시험접수`;
}

type PortoneApplyRequestBase = {
  portoneVersion: PortoneModuleVersion;
  storeId: string;
  channelKey: string;
  impCode?: string;
  pgProvider?: string;
  merchantId: string;
  paymentId: string;
  orderName: string;
  totalAmount: number;
  currency: 'KRW';
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customer: { fullName: string; email: string; phoneNumber: string };
  registrationNumber: string | null;
};

export type PortoneApplyRequestResult =
  | (PortoneApplyRequestBase & { alreadyIssued: false })
  | (PortoneApplyRequestBase & {
      alreadyIssued: true;
      vbankName: string;
      vbankNum: string;
      vbankExpiry: string;
    });

export type PortoneApplyConfirmResult =
  | {
      ok: true;
      status: 'VA_ISSUED';
      registrationId: string;
      vbankName: string;
      vbankNum: string;
      vbankExpiry: string;
      amount: number;
      orderName: string;
    }
  | {
      ok: true;
      status: 'PAID';
      registrationId: string;
    };

export type PortoneApplyTestConfirmResult = {
  ok: true;
  status: 'PAID';
  registrationId: string;
};

function wrapRequestResult(
  base: Omit<PortoneApplyRequestBase, 'paymentId' | 'customer'> & {
    merchantId: string;
    customerName: string;
    customerEmail: string;
    customerPhone: string;
  },
  rest: { alreadyIssued: false } | { alreadyIssued: true; vbankName: string; vbankNum: string; vbankExpiry: string },
): PortoneApplyRequestResult {
  const customer = {
    fullName: base.customerName,
    email: base.customerEmail,
    phoneNumber: base.customerPhone,
  };
  return {
    ...base,
    paymentId: base.merchantId,
    customer,
    ...rest,
  };
}

@Injectable()
export class PortoneApplyService {
  private readonly logger = new Logger(PortoneApplyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    @Inject(PORTONE_GATEWAY) private readonly portoneGateway: PortoneGateway,
    private readonly payments: PaymentsService,
  ) {}

  private moduleVersion(): PortoneModuleVersion {
    const raw = (this.config.get<string>('portone.moduleVersion') ?? 'v2').toLowerCase();
    return raw === 'v1' ? 'v1' : 'v2';
  }

  private assertPortoneChannelConfigured(): {
    portoneVersion: PortoneModuleVersion;
    storeId: string;
    channelKey: string;
    impCode: string;
    pgProvider: string;
  } {
    const portoneVersion = this.moduleVersion();
    const storeId = (this.config.get<string>('portone.storeId') ?? '').trim();
    const channelKey = (this.config.get<string>('portone.channelKey') ?? '').trim();
    const impCode = (this.config.get<string>('portone.v1ImpCode') ?? '').trim();
    const pgOverride = (this.config.get<string>('portone.v1Pg') ?? '').trim();
    const kcpSiteCode = (this.config.get<string>('portone.v1KcpSiteCode') ?? '').trim();
    let pgProvider = pgOverride;
    if (!pgProvider) {
      pgProvider = (this.config.get<string>('portone.v1PgProvider') ?? 'kcp').trim();
      if (portoneVersion === 'v1' && kcpSiteCode && !pgProvider.includes('.')) {
        pgProvider = `${pgProvider}.${kcpSiteCode}`;
      }
    }

    if (portoneVersion === 'v1') {
      if (!impCode) {
        throw new BadRequestException('PortOne V1 imp_code is not configured (PORTONE_V1_IMP_CODE)');
      }
      return { portoneVersion, storeId, channelKey, impCode, pgProvider };
    }
    if (!storeId || !channelKey) {
      throw new BadRequestException('PortOne store/channel is not configured');
    }
    return { portoneVersion, storeId, channelKey, impCode: '', pgProvider };
  }

  private async resolveFee(certType: string, level: string): Promise<number> {
    const lvl = await this.prisma.certificationLevel.findFirst({
      where: { level: level as never, certification: { type: certType as never } },
    });
    if (!lvl) throw new NotFoundException('Certification level missing');
    return lvl.fee;
  }

  private async expireSeatHold(registrationId: string, scheduleId: string) {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.registration.update({
        where: { id: registrationId },
        data: {
          status: RegistrationStatus.CANCELLED,
          cancelledAt: now,
          seatHeldUntil: null,
        },
      }),
      this.prisma.payment.updateMany({
        where: { registrationId, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.CANCELLED, cancelledAt: now },
      }),
      this.prisma.examSchedule.update({
        where: { id: scheduleId },
        data: { currentCount: { decrement: 1 } },
      }),
    ]);
  }

  private async fetchPaymentWithRetry(paymentId: string): Promise<PortonePaymentLike | null> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= PAYMENT_NETWORK_RETRY_LIMIT; attempt += 1) {
      try {
        return await this.portoneGateway.getPayment(paymentId);
      } catch (e) {
        lastErr = e;
      }
    }
    this.logger.warn(`PortOne getPayment failed after retries: ${String(lastErr)}`);
    return null;
  }

  async applyPaymentRequest(userId: string, registrationId: string): Promise<PortoneApplyRequestResult> {
    const { portoneVersion, storeId, channelKey, impCode, pgProvider } =
      this.assertPortoneChannelConfigured();

    const registration = await this.prisma.registration.findUnique({
      where: { id: registrationId },
      include: { user: true, schedule: true },
    });
    if (!registration) throw new NotFoundException('Registration not found');
    if (registration.userId !== userId) throw new ForbiddenException('Not your registration');
    if (registration.status !== RegistrationStatus.PENDING_PAYMENT) {
      throw new ConflictException(`Registration is in status ${registration.status}`);
    }
    if (isPendingPaymentHoldExpired(registration)) {
      await this.expireSeatHold(registration.id, registration.scheduleId);
      throw new ConflictException('SESSION_EXPIRED');
    }
    if (registration.certType === 'AXIS_C' && registration.level === 'L1' && !registration.supportDocUrl) {
      throw new BadRequestException('MISSING_L1_DOCUMENT');
    }

    const fee = await this.resolveFee(registration.certType, registration.level);
    const orderName = buildOrderNameKo(registration.certType, registration.level);

    const existingPortone = await this.prisma.payment.findFirst({
      where: {
        registrationId: registration.id,
        status: PaymentStatus.PENDING,
      },
      orderBy: { createdAt: 'desc' },
    });

    const customerBase = {
      customerName: registration.user.name,
      customerEmail: registration.user.email ?? '',
      customerPhone: registration.user.phone,
    };

    if (existingPortone?.paymentKey && existingPortone.rawResponse) {
      const parsed = existingPortone.rawResponse as unknown as PortonePaymentLike;
      try {
        const va = extractVaFromPayment(parsed);
        await this.redis.set(
          `payment:orderId:${existingPortone.orderId}`,
          registration.id,
          ORDER_TTL_SECONDS,
        );
        return wrapRequestResult(
          {
            portoneVersion,
            storeId,
            channelKey,
            impCode: impCode || undefined,
            pgProvider: pgProvider || undefined,
            merchantId: existingPortone.orderId,
            orderName,
            totalAmount: fee,
            currency: 'KRW',
            registrationNumber: registration.registrationNumber,
            ...customerBase,
          },
          { alreadyIssued: true, ...va },
        );
      } catch {
        /* fall through to re-issue */
      }
    }

    // Reuse pending row when VA not yet issued. Legacy `AXIS-{cuid}-{ms}` ids are
    // 44 chars and break KCP V2 (max 40) — rewrite those in place before returning.
    let paymentRow =
      existingPortone && !existingPortone.paymentKey
        ? existingPortone
        : await createPendingPaymentOrReuseOnRace(
            this.prisma,
            registration.id,
            buildPortoneMerchantOrderId(registrationId),
            fee,
          );

    if (needsNewPortoneOrderId(paymentRow.orderId)) {
      const previousOrderId = paymentRow.orderId;
      const orderId = buildPortoneMerchantOrderId(registrationId);
      paymentRow = await this.prisma.payment.update({
        where: { id: paymentRow.id },
        data: { orderId },
      });
      await this.redis.del(`payment:orderId:${previousOrderId}`);
    }

    if (paymentRow.amount !== fee) {
      paymentRow = await this.prisma.payment.update({
        where: { id: paymentRow.id },
        data: { amount: fee },
      });
    }

    await this.redis.set(`payment:orderId:${paymentRow.orderId}`, registration.id, ORDER_TTL_SECONDS);

    return wrapRequestResult(
      {
        portoneVersion,
        storeId,
        channelKey,
        impCode: impCode || undefined,
        pgProvider: pgProvider || undefined,
        merchantId: paymentRow.orderId,
        orderName,
        totalAmount: fee,
        currency: 'KRW',
        registrationNumber: registration.registrationNumber,
        ...customerBase,
      },
      { alreadyIssued: false },
    );
  }

  async applyPaymentConfirm(
    userId: string,
    input: { paymentId: string; merchantId: string },
  ): Promise<PortoneApplyConfirmResult> {
    const payment = await this.prisma.payment.findUnique({
      where: { orderId: input.merchantId },
      include: { registration: { include: { user: true } } },
    });
    if (!payment) throw new NotFoundException('Order not found');
    if (payment.registration.userId !== userId) throw new ForbiddenException('Not your order');

    const orderName = buildOrderNameKo(
      payment.registration.certType,
      payment.registration.level,
    );

    if (payment.status === PaymentStatus.CANCELLED) {
      throw new BadRequestException({ error: 'unexpected_status' });
    }

    if (payment.status === PaymentStatus.CONFIRMED) {
      return { ok: true, status: 'PAID', registrationId: payment.registrationId };
    }

    if (payment.rawResponse && payment.status === PaymentStatus.PENDING) {
      const fromRaw = payment.rawResponse as unknown as PortonePaymentLike;
      const remoteId = getPortoneRemotePaymentId(fromRaw);
      if (
        payment.paymentKey &&
        (input.paymentId === payment.paymentKey ||
          input.paymentId === payment.orderId ||
          input.paymentId === remoteId)
      ) {
        const va = extractVaFromPayment(fromRaw);
        return {
          ok: true,
          status: 'VA_ISSUED',
          registrationId: payment.registrationId,
          amount: payment.amount,
          orderName,
          ...va,
        };
      }
    }

    if (payment.status !== PaymentStatus.PENDING) {
      throw new BadRequestException({ error: 'unexpected_status' });
    }

    const remote = await this.fetchPaymentWithRetry(input.paymentId);
    if (!remote) {
      throw new BadRequestException('NETWORK_RETRY_EXCEEDED');
    }

    const status = remote.status;
    if (!status || !PORTONE_ISSUABLE.has(status)) {
      this.logger.warn(`PortOne confirm unexpected status=${String(status)}`);
      throw new BadRequestException({ error: 'unexpected_status' });
    }

    const total = portoneAmountTotal(remote);
    if (total !== payment.amount) {
      this.logger.error(
        `PortOne amount mismatch order=${payment.orderId} db=${payment.amount} portone=${total}`,
      );
      throw new BadRequestException({ error: 'amount_mismatch' });
    }

    const pgId = getPortoneRemotePaymentId(remote);

    if (status === 'PAID') {
      await this.payments.applyPortOnePaid({
        merchantId: payment.orderId,
        pgPaymentId: pgId,
        rawResponse: remote as unknown as Prisma.InputJsonValue,
      });
      return { ok: true, status: 'PAID', registrationId: payment.registrationId };
    }

    const va = extractVaFromPayment(remote);
    await this.payments.applyPortOneVaIssued({
      merchantId: payment.orderId,
      pgPaymentId: pgId,
      rawResponse: remote as unknown as Prisma.InputJsonValue,
    });

    this.logger.log(
      `PortOne VA issued: registration=${payment.registrationId} order=${payment.orderId}`,
    );

    return {
      ok: true,
      status: 'VA_ISSUED',
      registrationId: payment.registrationId,
      amount: payment.amount,
      orderName,
      ...va,
    };
  }

  /**
   * Demo/staging convenience: bypass PortOne entirely and flip the
   * registration to PAID. Gated by TEST_PAYMENT_ENABLED — the controller
   * throws NotFoundException when the flag is off so production never
   * exposes the route. Re-uses the same Payment row created by
   * `applyPaymentRequest`, so a real test-mode confirmation produces the
   * same downstream side effects (Payment.status=CONFIRMED,
   * Registration.status=PAID, examDeadline set) as a real PortOne PAID.
   */
  async applyPaymentTestConfirm(
    userId: string,
    registrationId: string,
  ): Promise<PortoneApplyTestConfirmResult> {
    const registration = await this.prisma.registration.findUnique({
      where: { id: registrationId },
    });
    if (!registration) throw new NotFoundException('Registration not found');
    if (registration.userId !== userId) {
      throw new ForbiddenException('Not your registration');
    }
    if (registration.status === RegistrationStatus.PAID) {
      return { ok: true, status: 'PAID', registrationId: registration.id };
    }
    if (registration.status !== RegistrationStatus.PENDING_PAYMENT) {
      throw new ConflictException(`Registration is in status ${registration.status}`);
    }

    const payment = await this.prisma.payment.findFirst({
      where: {
        registrationId: registration.id,
        status: PaymentStatus.PENDING,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) {
      throw new BadRequestException(
        'No pending payment to confirm — call /payment/request first',
      );
    }

    const syntheticPgId = `DEMO-${payment.orderId}-${Date.now()}`;
    await this.payments.applyPortOnePaid({
      merchantId: payment.orderId,
      pgPaymentId: syntheticPgId,
      rawResponse: {
        demo: true,
        confirmedBy: 'test-confirm',
        confirmedAt: new Date().toISOString(),
      } as Prisma.InputJsonValue,
    });
    this.logger.warn(
      `TEST payment confirmed: registration=${registration.id} order=${payment.orderId} (TEST_PAYMENT_ENABLED)`,
    );
    return { ok: true, status: 'PAID', registrationId: registration.id };
  }

  /**
   * V1 getPayment takes imp_uid (our transactionId hint); V2 getPayment takes
   * paymentId, which is the merchant-side order id. Try the likely ref first
   * so a webhook doesn't burn retries on a ref the API can never resolve.
   */
  private webhookRefOrder(event: { merchantOrderId: string; transactionId: string }): string[] {
    return this.portoneGateway.version === 'v1'
      ? [event.transactionId, event.merchantOrderId]
      : [event.merchantOrderId, event.transactionId];
  }

  private async fetchPaymentByRefs(refs: string[]): Promise<PortonePaymentLike | null> {
    const unique = [...new Set(refs.filter(Boolean))];
    let lastErr: unknown;
    for (let round = 0; round < 2; round += 1) {
      for (const ref of unique) {
        try {
          return await this.portoneGateway.getPayment(ref);
        } catch (e) {
          lastErr = e;
        }
      }
    }
    this.logger.warn(
      `PortOne getPayment failed for refs=[${unique.join(', ')}]: ${String(lastErr)}`,
    );
    return null;
  }

  /**
   * SECURITY MODEL — webhooks are untrusted triggers. Regardless of what the
   * webhook CLAIMS happened, the payment is re-fetched from the PG API over
   * TLS and only the API-reported state is applied (PaymentsService
   * .applyRemoteState). A spoofed webhook — V1 iamport callbacks are unsigned
   * — can therefore only trigger a lookup, never a state change the PG does
   * not itself confirm (e.g. a forged "cancelled" for a PAID order is a no-op).
   */
  private async reconcileFromRemote(event: {
    type: string;
    merchantOrderId: string;
    transactionId: string;
  }): Promise<void> {
    const remote = await this.fetchPaymentByRefs(this.webhookRefOrder(event));
    if (!remote?.status) return; // network exhaustion — PG webhook retry / reconcile cron will catch up

    const remoteId = getPortoneRemotePaymentId(remote);
    const local = await this.prisma.payment.findFirst({
      where: {
        OR: [
          { orderId: event.merchantOrderId },
          { orderId: event.transactionId },
          { orderId: remoteId },
          { paymentKey: event.transactionId },
          { paymentKey: remoteId },
        ],
      },
      select: { orderId: true, amount: true },
    });
    if (!local) {
      this.logger.warn(
        `PortOne webhook: no local payment for refs=${event.merchantOrderId}/${event.transactionId}`,
      );
      return;
    }

    const outcome = await this.payments.applyRemoteState(local, remote);
    if (outcome !== 'SKIPPED' && outcome !== event.type) {
      this.logger.warn(
        `PortOne webhook claimed ${event.type} but API reports ${outcome} — applied API state (order=${local.orderId})`,
      );
    }
  }

  async verifyAndHandleWebhookPayload(
    rawBodyUtf8: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<void> {
    const events = await this.portoneGateway.verifyWebhook(rawBodyUtf8, headers);
    for (const event of events) {
      await this.reconcileFromRemote(event);
    }
  }
}

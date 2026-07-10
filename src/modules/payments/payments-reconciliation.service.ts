import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentStatus, RegistrationStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../integrations/redis/redis.service';
import { PORTONE_GATEWAY, PortoneGateway } from './portone-gateway.interface';
import { PaymentsService } from './payments.service';
import type { PortonePaymentLike } from './portone-payment.types';

const SWEEP_LOCK_KEY = 'payments:reconcile:lock';
const SWEEP_LOCK_TTL_SEC = 240; // < 5-min cadence so a crashed sweep can't wedge the lock
const SWEEP_BATCH = 50;
const SWEEP_WINDOW_DAYS = 30;

/**
 * Safety net for the webhook path: virtual-account deposits are confirmed
 * asynchronously, so a single missed/failed webhook would otherwise strand a
 * customer who already paid. Every 5 minutes, re-check still-PENDING payments
 * against the PG API and apply whatever state it reports (same money-path as
 * the webhook — PaymentsService.applyRemoteState).
 *
 * Also probes the PG credentials once at boot so dead API keys surface in the
 * logs immediately instead of at the first customer payment.
 */
@Injectable()
export class PaymentsReconciliationService implements OnModuleInit {
  private readonly logger = new Logger(PaymentsReconciliationService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    @Inject(PORTONE_GATEWAY) private readonly gateway: PortoneGateway,
    private readonly payments: PaymentsService,
  ) {}

  onModuleInit(): void {
    void this.probeCredentialsAtBoot();
  }

  private gatewayConfigured(): boolean {
    if (this.gateway.version === 'v1') {
      const key =
        this.config.get<string>('portone.v1ImpKey')?.trim() ||
        this.config.get<string>('portone.v1ApiKey')?.trim();
      const secret =
        this.config.get<string>('portone.v1ImpSecret')?.trim() ||
        this.config.get<string>('portone.v1ApiSecret')?.trim();
      return !!key && !!secret;
    }
    return !!this.config.get<string>('portone.v2ApiSecret')?.trim();
  }

  private async probeCredentialsAtBoot(): Promise<void> {
    if (!this.gatewayConfigured()) {
      this.logger.warn(
        `PortOne ${this.gateway.version} credentials not configured — payment verification is disabled`,
      );
      return;
    }
    if (!this.gateway.probeCredentials) return;
    try {
      const res = await this.gateway.probeCredentials();
      if (res.ok) {
        this.logger.log(`PortOne credential probe OK: ${res.detail}`);
      } else {
        this.logger.error(
          `PortOne credential probe FAILED: ${res.detail} — deposits CANNOT be verified until the API keys are fixed`,
        );
      }
    } catch (e) {
      this.logger.error(`PortOne credential probe threw: ${String(e)}`);
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcilePendingPayments(): Promise<void> {
    if (this.sweeping || !this.gatewayConfigured()) return;
    // Cross-instance lock (best-effort — single pm2 instance today). Not
    // released on completion: the TTL expires before the next cadence.
    if (this.redis.isReady() && !(await this.redis.setNxEx(SWEEP_LOCK_KEY, SWEEP_LOCK_TTL_SEC))) {
      return;
    }
    this.sweeping = true;
    try {
      const cutoff = new Date(Date.now() - SWEEP_WINDOW_DAYS * 86_400_000);
      const rows = await this.prisma.payment.findMany({
        where: {
          status: PaymentStatus.PENDING,
          createdAt: { gte: cutoff },
          registration: { status: RegistrationStatus.PENDING_PAYMENT },
        },
        orderBy: { createdAt: 'asc' },
        take: SWEEP_BATCH,
        select: { id: true, orderId: true, paymentKey: true, amount: true },
      });
      if (!rows.length) return;

      const counts: Partial<Record<string, number>> = {};
      for (const row of rows) {
        const remote = await this.fetchRemote(row);
        if (!remote?.status) continue;
        const outcome = await this.payments.applyRemoteState(
          { orderId: row.orderId, amount: row.amount },
          remote,
        );
        counts[outcome] = (counts[outcome] ?? 0) + 1;
      }

      const acted = ['PAID', 'CANCELLED', 'FAILED'].some((k) => counts[k]);
      if (acted) {
        const summary = Object.entries(counts)
          .map(([k, v]) => `${k.toLowerCase()}=${v}`)
          .join(' ');
        this.logger.log(`Payment reconcile sweep: checked=${rows.length} ${summary}`);
      }
    } catch (e) {
      this.logger.warn(`Payment reconcile sweep failed: ${String(e)}`);
    } finally {
      this.sweeping = false;
    }
  }

  private async fetchRemote(row: {
    orderId: string;
    paymentKey: string | null;
  }): Promise<PortonePaymentLike | null> {
    try {
      // paymentKey = PG-side id (V1 imp_uid / V2 remote id) — the direct ref.
      if (row.paymentKey) return await this.gateway.getPayment(row.paymentKey);
      // No PG id persisted yet (confirm call was lost): look up by our order id.
      if (this.gateway.getPaymentByMerchantOrderId) {
        return await this.gateway.getPaymentByMerchantOrderId(row.orderId);
      }
      return await this.gateway.getPayment(row.orderId);
    } catch {
      return null; // not found at PG / transient network — retry next sweep
    }
  }
}

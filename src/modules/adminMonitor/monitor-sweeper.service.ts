import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ExamSessionStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../integrations/redis/redis.service';
import { AdminMonitorGateway } from './admin-monitor.gateway';
import { MonitorHeartbeatService } from './monitor-heartbeat.service';
import {
  AdminMonitorService,
  HEARTBEAT_LIVE_MS,
  type LiveStatus,
} from './admin-monitor.service';

const SWEEP_INTERVAL_MS = 5_000;
/**
 * Force-emit a session-update for every live session at this cadence even if
 * its status hasn't transitioned, so a freshly-connected admin doesn't have
 * to wait for the next state change to see who's online.
 */
const KEEPALIVE_EMIT_MS = 15_000;

interface SessionSnapshot {
  status: LiveStatus;
  warnings: number;
  emittedAt: number;
}

/**
 * Periodically reconciles candidate liveness with the admin monitor:
 *   • flips IN_PROGRESS sessions whose heartbeat went stale into a derived
 *     `disconnected` status and pushes that to admins
 *   • re-broadcasts the top-bar `exam:live-status` summary so the "1 takers /
 *     0 alerts" pill stays accurate without any admin having to refresh
 *
 * Pure read-only against the DB — never mutates exam-session rows. The DB
 * stays the source of truth for the lifecycle (CREATED → IN_PROGRESS →
 * SUBMITTED / TERMINATED); we just layer disconnect/reconnect on top of it
 * using the in-memory heartbeat tracker.
 */
@Injectable()
export class MonitorSweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MonitorSweeperService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly snapshots = new Map<string, SessionSnapshot>();
  private inflight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AdminMonitorGateway,
    private readonly heartbeat: MonitorHeartbeatService,
    private readonly monitor: AdminMonitorService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.sweepOnce();
    }, SWEEP_INTERVAL_MS);
    // Defer the first run a few seconds so the rest of the app finishes
    // booting (Redis, DB pool, etc.) before we start reading.
    setTimeout(() => void this.sweepOnce(), 2_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async sweepOnce(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      const now = Date.now();

      // Pull every IN_PROGRESS session in one query (ID + cheap fields only).
      // Per-tick cost: one indexed scan; we don't load answers here.
      const sessions = await this.prisma.examSession.findMany({
        where: { status: ExamSessionStatus.IN_PROGRESS, startedAt: { not: null } },
        select: {
          id: true,
          certType: true,
          level: true,
          proctorWarnings: true,
          user: { select: { name: true } },
        },
      });

      if (sessions.length === 0) {
        this.snapshots.clear();
        await this.gateway.broadcastLiveStatus().catch(() => undefined);
        return;
      }

      // Without Redis the heartbeat layer is blind, so the sweep can't make a
      // disconnect/connected decision. Skip status mutation in that case but
      // still re-broadcast the live-status summary (which falls back to "trust
      // the DB") so admins keep seeing the chrome-bar takers count tick.
      const redisUp = this.redis.isReady();
      const heartbeats = redisUp
        ? await this.heartbeat.getLastSeenMany(sessions.map((s) => s.id))
        : new Map<string, number>();
      const seenIds = new Set<string>();

      for (const s of sessions) {
        seenIds.add(s.id);
        const lastSeen = heartbeats.get(s.id) ?? null;
        const stale = redisUp && (lastSeen == null || now - lastSeen > HEARTBEAT_LIVE_MS);
        const status: LiveStatus = stale
          ? 'disconnected'
          : s.proctorWarnings >= 3
          ? 'danger'
          : s.proctorWarnings >= 1
          ? 'warning'
          : 'normal';

        const prev = this.snapshots.get(s.id);
        const transitioned =
          !prev || prev.status !== status || prev.warnings !== s.proctorWarnings;
        const stale_emit = !prev || now - prev.emittedAt > KEEPALIVE_EMIT_MS;
        if (transitioned || stale_emit) {
          this.snapshots.set(s.id, { status, warnings: s.proctorWarnings, emittedAt: now });
          await this.gateway
            .emitSessionUpdate({
              sessionId: s.id,
              status,
              progressPct: 0, // tile keeps its locally-tracked progress; this update is about status
              warnings: s.proctorWarnings,
              candidateName: s.user?.name ?? 'Unknown',
              examName: `${s.certType.replace('_', '-')} ${s.level}`,
            })
            .catch((err) =>
              this.logger.warn(`emit session-update failed: ${(err as Error).message}`),
            );
        }
        // Surface disconnect / reconnect on the live feed (once per transition).
        if (prev && prev.status !== status) {
          const name = s.user?.name ?? 'Unknown';
          if (status === 'disconnected' && prev.status !== 'disconnected') {
            void this.gateway.emitAlert({
              sessionId: s.id,
              level: 'MEDIUM',
              message: `${name} — network disconnected`,
              ts: now,
            });
          } else if (prev.status === 'disconnected' && status !== 'disconnected') {
            void this.gateway.emitAlert({
              sessionId: s.id,
              level: 'INFO',
              message: `${name} — network reconnected`,
              ts: now,
            });
          }
        }
      }

      // Drop in-memory snapshots for sessions that have left IN_PROGRESS — the
      // emit for the terminal transition is already handled by the lifecycle
      // path in CbtSessionsService / GradingService.
      for (const id of Array.from(this.snapshots.keys())) {
        if (!seenIds.has(id)) this.snapshots.delete(id);
      }

      await this.gateway.broadcastLiveStatus().catch(() => undefined);
    } catch (err) {
      this.logger.warn(`sweep tick failed: ${(err as Error).message}`);
    } finally {
      this.inflight = false;
    }
  }
}

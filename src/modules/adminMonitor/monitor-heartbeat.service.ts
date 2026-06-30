import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../integrations/redis/redis.service';

/**
 * Per-session liveness tracker. Every authenticated proctor activity from a
 * candidate (webcam thumb, screen thumb, face check, AI review, answer save,
 * proctor event POST) bumps a Redis key. The admin sweeper reads this to
 * decide whether a session that DB-says is `IN_PROGRESS` is actually still
 * connected, or if the candidate has dropped off.
 *
 * Pure in-memory / Redis state — never writes to the database. We can't
 * change `ExamSession.status` to "disconnected" because that's a real session
 * lifecycle column the candidate is allowed to come back to. Instead, the
 * admin UI gets a derived `disconnected` status while the underlying row
 * stays `IN_PROGRESS`, so re-entry works the moment the next heartbeat lands.
 */
@Injectable()
export class MonitorHeartbeatService {
  private readonly logger = new Logger(MonitorHeartbeatService.name);

  /** Local fallback for when Redis is offline so dev/test still works. */
  private readonly local = new Map<string, number>();

  /** Sessions live in Redis for 1 hour after their last heartbeat. */
  private readonly TTL_SEC = 3_600;

  constructor(private readonly redis: RedisService) {}

  private key(sessionId: string): string {
    return `monitor:lastseen:${sessionId}`;
  }

  /** Bump the per-session heartbeat. Safe to call from any request handler. */
  async markAlive(sessionId: string): Promise<void> {
    const now = Date.now();
    this.local.set(sessionId, now);
    if (this.redis.isReady()) {
      try {
        await this.redis.set(this.key(sessionId), String(now), this.TTL_SEC);
      } catch (err) {
        this.logger.warn(`markAlive failed sessionId=${sessionId}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Returns the epoch-ms of the last heartbeat for `sessionId`, or null when
   * no heartbeat has ever landed (e.g. the session was started but the
   * candidate never reached the exam runner).
   */
  async getLastSeen(sessionId: string): Promise<number | null> {
    if (this.redis.isReady()) {
      try {
        const raw = await this.redis.get(this.key(sessionId));
        if (raw) {
          const n = Number(raw);
          if (Number.isFinite(n)) return n;
        }
      } catch (err) {
        this.logger.warn(`getLastSeen failed sessionId=${sessionId}: ${(err as Error).message}`);
      }
    }
    return this.local.get(sessionId) ?? null;
  }

  /** Bulk variant — one Redis round-trip per session, but the local map is O(1). */
  async getLastSeenMany(sessionIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    await Promise.all(
      sessionIds.map(async (id) => {
        const ts = await this.getLastSeen(id);
        if (ts != null) out.set(id, ts);
      }),
    );
    return out;
  }

  /** Drop a session's heartbeat — used when a session terminates / submits. */
  async clear(sessionId: string): Promise<void> {
    this.local.delete(sessionId);
    if (this.redis.isReady()) {
      try {
        await this.redis.del(this.key(sessionId));
      } catch (err) {
        this.logger.warn(`clear failed sessionId=${sessionId}: ${(err as Error).message}`);
      }
    }
  }
}

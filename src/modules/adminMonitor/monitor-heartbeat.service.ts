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

  private webcamKey(sessionId: string): string {
    return `monitor:webcam:${sessionId}`;
  }

  private screenKey(sessionId: string): string {
    return `monitor:screen:${sessionId}`;
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

  /** Bump webcam-stream freshness (separate from overall liveness). */
  async markWebcam(sessionId: string, ts: number = Date.now()): Promise<void> {
    this.local.set(this.webcamKey(sessionId), ts);
    await this.markAlive(sessionId);
    if (this.redis.isReady()) {
      try {
        await this.redis.set(this.webcamKey(sessionId), String(ts), this.TTL_SEC);
      } catch (err) {
        this.logger.warn(`markWebcam failed sessionId=${sessionId}: ${(err as Error).message}`);
      }
    }
  }

  /** Bump screen-share stream freshness. */
  async markScreen(sessionId: string, ts: number = Date.now()): Promise<void> {
    this.local.set(this.screenKey(sessionId), ts);
    await this.markAlive(sessionId);
    if (this.redis.isReady()) {
      try {
        await this.redis.set(this.screenKey(sessionId), String(ts), this.TTL_SEC);
      } catch (err) {
        this.logger.warn(`markScreen failed sessionId=${sessionId}: ${(err as Error).message}`);
      }
    }
  }

  async getWebcamLastSeen(sessionId: string): Promise<number | null> {
    return this.readTs(this.webcamKey(sessionId));
  }

  async getScreenLastSeen(sessionId: string): Promise<number | null> {
    return this.readTs(this.screenKey(sessionId));
  }

  private async readTs(key: string): Promise<number | null> {
    if (this.redis.isReady()) {
      try {
        const raw = await this.redis.get(key);
        if (raw) {
          const n = Number(raw);
          if (Number.isFinite(n)) return n;
        }
      } catch (err) {
        this.logger.warn(`readTs failed key=${key}: ${(err as Error).message}`);
      }
    }
    return this.local.get(key) ?? null;
  }

  async getMediaLastSeenMany(
    sessionIds: string[],
  ): Promise<{ webcam: Map<string, number>; screen: Map<string, number> }> {
    const webcam = new Map<string, number>();
    const screen = new Map<string, number>();
    await Promise.all(
      sessionIds.map(async (id) => {
        const [w, s] = await Promise.all([
          this.getWebcamLastSeen(id),
          this.getScreenLastSeen(id),
        ]);
        if (w != null) webcam.set(id, w);
        if (s != null) screen.set(id, s);
      }),
    );
    return { webcam, screen };
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
    this.local.delete(this.webcamKey(sessionId));
    this.local.delete(this.screenKey(sessionId));
    if (this.redis.isReady()) {
      try {
        await Promise.all([
          this.redis.del(this.key(sessionId)),
          this.redis.del(this.webcamKey(sessionId)),
          this.redis.del(this.screenKey(sessionId)),
        ]);
      } catch (err) {
        this.logger.warn(`clear failed sessionId=${sessionId}: ${(err as Error).message}`);
      }
    }
  }
}

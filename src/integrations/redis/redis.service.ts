import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { type Redis as RedisClient } from 'ioredis';

export type RedisMessageHandler = (message: string, channel: string) => void;

/**
 * Lightweight Redis facade used by the AI proctoring pipeline:
 *   • setNxEx(key, ttl) — atomic cost-cap gate (Claude rate limit, idempotency)
 *   • publish(channel, payload) — fan out admin:ai-alert across nodes
 *   • subscribe(channel, handler) — used by AdminGateway to relay to Socket.io
 *
 * Two clients are kept: one for normal commands and one in subscribe mode
 * (ioredis disallows mixing pub/sub with regular commands on a single client).
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly url: string;
  private cmd!: RedisClient;
  private sub!: RedisClient;
  private readonly handlers = new Map<string, Set<RedisMessageHandler>>();
  private connected = false;

  constructor(config: ConfigService) {
    this.url = config.get<string>('redis.url') ?? 'redis://127.0.0.1:6379';
  }

  onModuleInit(): void {
    this.cmd = new Redis(this.url, {
      // Best-effort connect: the proctor pipeline degrades to OK on any Redis
      // failure so failing-loud at boot would also ground the rest of the app.
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 500, 5_000),
    });
    // Subscribe client overrides offline queue → true. Other modules call
    // `subscribe()` from their own `onModuleInit()`, which fires concurrently
    // with `cmd.connect()` below — without an offline queue ioredis throws
    // "Stream isn't writeable" and the subscribe is silently dropped, so admin
    // alerts / live-status broadcasts never reach the dashboard. The command
    // client keeps `enableOfflineQueue: false` because setNxEx etc. SHOULD
    // fail fast when Redis is down (that's the cost-cap design).
    this.sub = this.cmd.duplicate({ enableOfflineQueue: true });

    this.cmd.on('error', (err) => this.logger.warn(`redis cmd error: ${err.message}`));
    this.sub.on('error', (err) => this.logger.warn(`redis sub error: ${err.message}`));

    void Promise.all([this.cmd.connect(), this.sub.connect()])
      .then(() => {
        this.connected = true;
        this.logger.log('Redis connected');
      })
      .catch((err: Error) =>
        this.logger.warn(`Redis connect failed (degraded mode): ${err.message}`),
      );

    this.sub.on('message', (channel, message) => {
      const set = this.handlers.get(channel);
      if (!set) return;
      for (const fn of set) {
        try {
          fn(message, channel);
        } catch (err) {
          this.logger.warn(`subscriber threw: ${(err as Error).message}`);
        }
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    try {
      this.cmd?.disconnect();
      this.sub?.disconnect();
    } catch {
      /* ignore */
    }
  }

  isReady(): boolean {
    return this.connected && this.cmd?.status === 'ready';
  }

  /** Atomic SET NX EX. Returns true if the caller acquired the slot. */
  async setNxEx(key: string, ttlSeconds: number, value = '1'): Promise<boolean> {
    if (!this.isReady()) return false;
    try {
      const res = await this.cmd.set(key, value, 'EX', ttlSeconds, 'NX');
      return res === 'OK';
    } catch (err) {
      this.logger.warn(`setNxEx failed: ${(err as Error).message}`);
      return false;
    }
  }

  /** GET a key. Returns null when Redis is unavailable or key is missing. */
  async get(key: string): Promise<string | null> {
    if (!this.isReady()) return null;
    try {
      return await this.cmd.get(key);
    } catch (err) {
      this.logger.warn(`get failed key=${key}: ${(err as Error).message}`);
      return null;
    }
  }

  /** SET a key with optional TTL (seconds). Fire-and-forget on Redis unavailability. */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.isReady()) return;
    try {
      if (ttlSeconds) {
        await this.cmd.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.cmd.set(key, value);
      }
    } catch (err) {
      this.logger.warn(`set failed key=${key}: ${(err as Error).message}`);
    }
  }

  /** DEL a key. Fire-and-forget on Redis unavailability. */
  async del(key: string): Promise<void> {
    if (!this.isReady()) return;
    try {
      await this.cmd.del(key);
    } catch (err) {
      this.logger.warn(`del failed key=${key}: ${(err as Error).message}`);
    }
  }

  /** INCR a key. Returns null when Redis is unavailable. */
  async incr(key: string): Promise<number | null> {
    if (!this.isReady()) return null;
    try {
      return await this.cmd.incr(key);
    } catch (err) {
      this.logger.warn(`incr failed key=${key}: ${(err as Error).message}`);
      return null;
    }
  }

  /** LPUSH + optional LTRIM. Fire-and-forget on Redis unavailability. */
  async lpushTrim(key: string, value: string, maxLen: number): Promise<void> {
    if (!this.isReady()) return;
    try {
      await this.cmd.lpush(key, value);
      await this.cmd.ltrim(key, 0, maxLen - 1);
    } catch (err) {
      this.logger.warn(`lpushTrim failed key=${key}: ${(err as Error).message}`);
    }
  }

  /** LRANGE a list. Returns [] when Redis is unavailable. */
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    if (!this.isReady()) return [];
    try {
      return await this.cmd.lrange(key, start, stop);
    } catch (err) {
      this.logger.warn(`lrange failed key=${key}: ${(err as Error).message}`);
      return [];
    }
  }

  /** LREM — remove count occurrences of value from a list. */
  async lrem(key: string, count: number, value: string): Promise<void> {
    if (!this.isReady()) return;
    try {
      await this.cmd.lrem(key, count, value);
    } catch (err) {
      this.logger.warn(`lrem failed key=${key}: ${(err as Error).message}`);
    }
  }

  async publish(channel: string, payload: string): Promise<void> {
    if (!this.isReady()) return;
    try {
      await this.cmd.publish(channel, payload);
    } catch (err) {
      this.logger.warn(`publish failed: ${(err as Error).message}`);
    }
  }

  async subscribe(channel: string, handler: RedisMessageHandler): Promise<void> {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set<RedisMessageHandler>();
      this.handlers.set(channel, set);
      try {
        await this.sub.subscribe(channel);
      } catch (err) {
        this.logger.warn(
          `subscribe failed (channel=${channel}): ${(err as Error).message}`,
        );
      }
    }
    set.add(handler);
  }
}

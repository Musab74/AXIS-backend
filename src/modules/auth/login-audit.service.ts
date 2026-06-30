import { Injectable } from '@nestjs/common';
import { RedisService } from '../../integrations/redis/redis.service';

const LOGIN_AUDIT_KEY = (userId: string) => `login-audit:${userId}`;
const MAX_LOGIN_ENTRIES = 50;

export type LoginAuditSource = 'web' | 'admin';

export interface LoginAuditEntry {
  at: string;
  ip: string;
  userAgent: string | null;
  source: LoginAuditSource;
}

@Injectable()
export class LoginAuditService {
  constructor(private readonly redis: RedisService) {}

  async recordLogin(
    userId: string,
    ip: string | undefined,
    userAgent: string | undefined,
    source: LoginAuditSource,
  ): Promise<void> {
    const entry: LoginAuditEntry = {
      at: new Date().toISOString(),
      ip: ip?.trim() || 'unknown',
      userAgent: userAgent?.trim() || null,
      source,
    };
    await this.redis.lpushTrim(
      LOGIN_AUDIT_KEY(userId),
      JSON.stringify(entry),
      MAX_LOGIN_ENTRIES,
    );
  }

  async getLoginHistory(userId: string): Promise<LoginAuditEntry[]> {
    const raw = await this.redis.lrange(LOGIN_AUDIT_KEY(userId), 0, MAX_LOGIN_ENTRIES - 1);
    const entries: LoginAuditEntry[] = [];
    for (const line of raw) {
      try {
        const parsed = JSON.parse(line) as LoginAuditEntry;
        if (parsed.at && parsed.ip) entries.push(parsed);
      } catch {
        /* skip malformed */
      }
    }
    return entries;
  }
}

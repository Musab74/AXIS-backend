import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { RedisService } from '../../integrations/redis/redis.service';

function parseRefreshTtlSeconds(config: ConfigService): number {
  const raw = (config.get<string>('jwt.refreshExpiresIn') ?? '14d').trim();
  const m = raw.match(/^(\d+)([smhd])$/i);
  if (!m) return 14 * 86_400;
  const n = parseInt(m[1], 10);
  switch (m[2].toLowerCase()) {
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3_600;
    default:
      return n * 86_400;
  }
}

@Injectable()
export class AuthSessionService {
  private readonly sessionTtlSec: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.sessionTtlSec = parseRefreshTtlSeconds(config);
  }

  private key(userDbId: string): string {
    return `auth:active-session:${userDbId}`;
  }

  /** New login — replaces any prior device session for this account. */
  async beginSession(userDbId: string): Promise<string> {
    const sessionId = randomUUID();
    await this.redis.set(this.key(userDbId), sessionId, this.sessionTtlSec);
    return sessionId;
  }

  async revokeSession(userDbId: string): Promise<void> {
    await this.redis.del(this.key(userDbId));
  }

  async touchSession(userDbId: string, sessionId: string): Promise<void> {
    const active = await this.redis.get(this.key(userDbId));
    if (active === sessionId) {
      await this.redis.set(this.key(userDbId), sessionId, this.sessionTtlSec);
    }
  }

  async assertSessionActive(userDbId: string, sessionId: string | undefined): Promise<void> {
    if (!sessionId) {
      throw new UnauthorizedException({
        message:
          '동일 계정이 다른 기기(또는 브라우저)에서 로그인되어, 보안을 위해 현재 기기에서 자동 로그아웃되었습니다.',
        error: 'SESSION_SUPERSEDED',
      });
    }

    if (!this.redis.isReady()) {
      return;
    }

    const active = await this.redis.get(this.key(userDbId));
    if (active === null || active !== sessionId) {
      throw new UnauthorizedException({
        message:
          '동일 계정이 다른 기기(또는 브라우저)에서 로그인되어, 보안을 위해 현재 기기에서 자동 로그아웃되었습니다.',
        error: 'SESSION_SUPERSEDED',
      });
    }
  }
}

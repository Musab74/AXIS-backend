import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthSessionService } from './auth-session.service';

describe('AuthSessionService', () => {
  const redis = {
    set: jest.fn(async () => undefined),
    get: jest.fn(async () => null as string | null),
    del: jest.fn(async () => undefined),
    isReady: jest.fn(() => true),
  };

  const config = {
    get: jest.fn((key: string) => (key === 'jwt.refreshExpiresIn' ? '14d' : undefined)),
  } as unknown as ConfigService;

  function svc() {
    return new AuthSessionService(redis as never, config);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    redis.isReady.mockReturnValue(true);
  });

  it('beginSession stores a new session id in Redis', async () => {
    const sessionId = await svc().beginSession('user-1');
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(redis.set).toHaveBeenCalledWith(
      'auth:active-session:user-1',
      sessionId,
      14 * 86_400,
    );
  });

  it('assertSessionActive rejects missing sid', async () => {
    await expect(svc().assertSessionActive('user-1', undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    try {
      await svc().assertSessionActive('user-1', undefined);
    } catch (e) {
      expect((e as UnauthorizedException).getResponse()).toMatchObject({
        error: 'SESSION_SUPERSEDED',
      });
    }
  });

  it('assertSessionActive rejects when Redis has a different session', async () => {
    redis.get.mockResolvedValueOnce('other-session');
    await expect(svc().assertSessionActive('user-1', 'my-session')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    try {
      redis.get.mockResolvedValueOnce('other-session');
      await svc().assertSessionActive('user-1', 'my-session');
    } catch (e) {
      expect((e as UnauthorizedException).getResponse()).toMatchObject({
        error: 'SESSION_SUPERSEDED',
      });
    }
  });

  it('assertSessionActive passes when session matches', async () => {
    redis.get.mockResolvedValueOnce('my-session');
    await expect(svc().assertSessionActive('user-1', 'my-session')).resolves.toBeUndefined();
  });

  it('skips Redis check when Redis is not ready', async () => {
    redis.isReady.mockReturnValue(false);
    await expect(svc().assertSessionActive('user-1', 'my-session')).resolves.toBeUndefined();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('revokeSession deletes the Redis key', async () => {
    await svc().revokeSession('user-1');
    expect(redis.del).toHaveBeenCalledWith('auth:active-session:user-1');
  });
});

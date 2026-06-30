import { RedisService } from '../../integrations/redis/redis.service';

export const BONUS_ATTEMPTS_KEY = (registrationId: string) =>
  `registration:${registrationId}:bonusAttempts`;

/** Max bonus attempts an admin may grant per registration (on top of MAX_ATTEMPTS). */
export const MAX_BONUS_ATTEMPTS = 2;

export async function getBonusAttempts(
  redis: RedisService,
  registrationId: string,
): Promise<number> {
  const raw = await redis.get(BONUS_ATTEMPTS_KEY(registrationId));
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

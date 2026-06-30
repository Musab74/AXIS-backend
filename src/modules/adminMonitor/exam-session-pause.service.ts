import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { RedisService } from '../../integrations/redis/redis.service';

export const EXAM_PAUSE_KEY = (sessionId: string): string => `exam:pause:${sessionId}`;

/** Max pause duration before Redis key expires (4 h safety net). */
const PAUSE_TTL_SEC = 4 * 60 * 60;

export interface ExamPauseState {
  pausedAt: number;
  actorId: string;
  reason?: string;
}

@Injectable()
export class ExamSessionPauseService {
  constructor(private readonly redis: RedisService) {}

  async getPauseState(sessionId: string): Promise<ExamPauseState | null> {
    const raw = await this.redis.get(EXAM_PAUSE_KEY(sessionId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as ExamPauseState;
      if (typeof parsed.pausedAt !== 'number') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async isPaused(sessionId: string): Promise<boolean> {
    return (await this.getPauseState(sessionId)) != null;
  }

  async assertNotPaused(sessionId: string): Promise<void> {
    if (await this.isPaused(sessionId)) {
      throw new HttpException(
        'Exam timer is paused by the proctor. Please wait until the proctor resumes the exam.',
        HttpStatus.LOCKED,
      );
    }
  }

  async setPaused(sessionId: string, state: ExamPauseState): Promise<void> {
    await this.redis.set(EXAM_PAUSE_KEY(sessionId), JSON.stringify(state), PAUSE_TTL_SEC);
  }

  async clearPaused(sessionId: string): Promise<void> {
    await this.redis.del(EXAM_PAUSE_KEY(sessionId));
  }
}

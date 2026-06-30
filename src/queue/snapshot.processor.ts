import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PenaltyStatus, ProctorEventType } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

const RETAIN_PENALTY_DAYS = 365 * 2;
const BATCH = 200;

const AI_EVIDENCE_TYPES: ProctorEventType[] = [
  ProctorEventType.AI_FLAG_SUSPICIOUS,
  ProctorEventType.AI_FLAG_CONFIRMED,
  ProctorEventType.AUDIO_HIGH,
];

/**
 * Retention sweeper for AI-proctor evidence. Runs hourly.
 *
 *   1. For every event past `retainUntil`, check if a UserPenalty is ACTIVE
 *      for that session. If so, extend retainUntil to +2y and skip deletion.
 *   2. Otherwise, NULL the storage URLs (the actual NCP delete is performed
 *      by bucket lifecycle; we drop the pointers so signed URLs stop working).
 *
 * NCP credentials may be missing in dev — the URL nulling still runs so DB
 * state remains consistent.
 */
@Injectable()
export class SnapshotRetentionProcessor {
  private readonly logger = new Logger(SnapshotRetentionProcessor.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweep(): Promise<void> {
    const now = new Date();
    const expired = await this.prisma.proctoringEvent.findMany({
      where: {
        eventType: { in: AI_EVIDENCE_TYPES },
        retainUntil: { lt: now },
        OR: [{ evidenceUrl: { not: null } }, { videoClipUrl: { not: null } }],
      },
      take: BATCH,
      orderBy: { retainUntil: 'asc' },
    });

    if (expired.length === 0) return;

    let bumped = 0;
    let purged = 0;
    for (const ev of expired) {
      const activePenalty = await this.prisma.userPenalty.findFirst({
        where: { sessionId: ev.sessionId, status: PenaltyStatus.ACTIVE },
      });
      if (activePenalty) {
        await this.prisma.proctoringEvent.update({
          where: { id: ev.id },
          data: {
            retainUntil: new Date(Date.now() + RETAIN_PENALTY_DAYS * 86_400_000),
          },
        });
        bumped += 1;
      } else {
        await this.prisma.proctoringEvent.update({
          where: { id: ev.id },
          data: { evidenceUrl: null, videoClipUrl: null },
        });
        purged += 1;
      }
    }

    this.logger.log(
      `retention sweep: scanned=${expired.length} bumped=${bumped} purged=${purged}`,
    );
  }
}

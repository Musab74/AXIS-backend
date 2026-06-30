/**
 * One-off: purge exam / registration / payment history for a user (by login id).
 * Keeps the User account row so they can log in and register again.
 *
 * Usage: npx ts-node prisma/purge-user-exam-data.ts andrew03
 */
import { PrismaClient, RegistrationStatus } from '@prisma/client';
import Redis from 'ioredis';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const SEAT_COUNT_STATUSES: RegistrationStatus[] = [
  RegistrationStatus.PAID,
  RegistrationStatus.EXAM_COMPLETED,
];

async function main() {
  const loginId = process.argv[2]?.trim();
  if (!loginId) {
    console.error('Usage: npx ts-node prisma/purge-user-exam-data.ts <userId>');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });

  try {
    const user = await prisma.user.findUnique({
      where: { userId: loginId },
      select: { id: true, userId: true, name: true },
    });
    if (!user) {
      console.error(`User not found: ${loginId}`);
      process.exit(1);
    }

    const sessions = await prisma.examSession.findMany({
      where: { userId: user.id },
      select: { id: true },
    });
    const sessionIds = sessions.map((s) => s.id);

    const registrations = await prisma.registration.findMany({
      where: { userId: user.id },
      select: { id: true, status: true, scheduleId: true },
    });
    const regIds = registrations.map((r) => r.id);

    console.log(`Purging ${loginId} (${user.name})`);
    console.log(`  sessions: ${sessionIds.length}, registrations: ${regIds.length}`);

    const summary = await prisma.$transaction(async (tx) => {
      if (sessionIds.length > 0) {
        const esc = sessionIds.map(() => '?').join(',');
        await tx.$executeRawUnsafe(
          `DELETE FROM expert_scoring_records WHERE session_id IN (${esc})`,
          ...sessionIds,
        );
      }

      // Clear partial-exempt pointers from other users (if any).
      if (sessionIds.length > 0) {
        await tx.registration.updateMany({
          where: { exemptSourceSessionId: { in: sessionIds } },
          data: { exemptSourceSessionId: null, partialExempt: false },
        });
      }

      const deletedSessions = await tx.examSession.deleteMany({
        where: { userId: user.id },
      });

      const deletedPayments = await tx.payment.deleteMany({
        where: { registration: { userId: user.id } },
      });

      let seatsReleased = 0;
      for (const reg of registrations) {
        if (SEAT_COUNT_STATUSES.includes(reg.status)) {
          await tx.examSchedule.update({
            where: { id: reg.scheduleId },
            data: { currentCount: { decrement: 1 } },
          });
          seatsReleased += 1;
        }
      }

      const deletedRegs = await tx.registration.deleteMany({
        where: { userId: user.id },
      });

      let deletedCerts = 0;
      try {
        const certResult = await tx.$executeRawUnsafe(
          'DELETE FROM certificates WHERE user_id = ?',
          user.id,
        );
        deletedCerts = Number(certResult);
      } catch {
        /* certificates table may not exist */
      }

      await tx.userPenalty.deleteMany({ where: { userId: user.id } });

      return {
        deletedSessions: deletedSessions.count,
        deletedPayments: deletedPayments.count,
        deletedRegs: deletedRegs.count,
        deletedCerts,
        seatsReleased,
      };
    });

    try {
      await redis.connect();
      await redis.del(`login-audit:${user.id}`);
      for (const regId of regIds) {
        await redis.del(`registration:${regId}:bonusAttempts`);
      }
    } catch {
      /* Redis optional */
    } finally {
      redis.disconnect();
    }

    console.log('Done:', summary);
    console.log(`User account ${loginId} kept — they can register again from scratch.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

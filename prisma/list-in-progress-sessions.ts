/**
 * READ-ONLY diagnostic — lists every exam session currently stuck in
 * IN_PROGRESS so the operator can pick the right row to finish. Does NOT
 * mutate the database; safe to run in production.
 *
 *   npx ts-node prisma/list-in-progress-sessions.ts
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.examSession.findMany({
      where: { status: 'IN_PROGRESS' },
      orderBy: { startedAt: 'asc' },
      select: {
        id: true,
        userId: true,
        certType: true,
        level: true,
        attemptNo: true,
        startedAt: true,
        hardDeadline: true,
        proctorWarnings: true,
        registrationId: true,
        user: { select: { name: true, email: true } },
      },
    });

    if (rows.length === 0) {
      console.log('No IN_PROGRESS sessions found.');
      return;
    }

    console.log(`Found ${rows.length} IN_PROGRESS session(s):\n`);
    for (const r of rows) {
      const startedMin = r.startedAt
        ? Math.round((Date.now() - new Date(r.startedAt).getTime()) / 60_000)
        : null;
      const deadlinePast = r.hardDeadline
        ? new Date(r.hardDeadline).getTime() < Date.now()
        : false;
      console.log('─'.repeat(72));
      console.log(`sessionId       : ${r.id}`);
      console.log(`candidate       : ${r.user?.name ?? '(unknown)'} <${r.user?.email ?? ''}>`);
      console.log(`userId          : ${r.userId}`);
      console.log(`exam            : ${r.certType.replace('_', '-')} ${r.level} (attempt #${r.attemptNo})`);
      console.log(`startedAt       : ${r.startedAt ?? '(null)'}${startedMin != null ? ` — ${startedMin} min ago` : ''}`);
      console.log(`hardDeadline    : ${r.hardDeadline ?? '(null)'}${deadlinePast ? '  ⚠ DEADLINE PAST' : ''}`);
      console.log(`proctorWarnings : ${r.proctorWarnings}`);
      console.log(`registrationId  : ${r.registrationId ?? '(none)'}`);
    }
    console.log('─'.repeat(72));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

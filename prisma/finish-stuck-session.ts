/**
 * One-off cleanup — finishes a single stuck IN_PROGRESS exam session that
 * was orphaned because the original `ExamRunnerPage` voice-strike threshold
 * handler only navigated the candidate away client-side (no server
 * termination was ever sent). Going forward the new
 * `terminateForVoiceStrikes` service method + `/proctor/voice-strike-threshold`
 * endpoint cover this automatically; this script exists ONLY to clean up
 * the row that was already stuck before the fix shipped.
 *
 * What it does (all in one transaction, idempotent):
 *   1. Insert an `AUDIO_HIGH` proctoringEvent audit row with
 *      `metadata.kind = 'VOICE_STRIKE_THRESHOLD'` so admin tooling
 *      renders the same trigger reason the new code path uses.
 *   2. Flip `examSession.status` IN_PROGRESS → TERMINATED with
 *      `failReason = "Forced termination — voice/noise strike threshold reached
 *      (Article 28). Strikes: 3."`
 *   3. Saturate `proctorWarnings` to 3 so admin badges agree.
 *   4. Re-evaluate the parent registration and flip to EXAM_COMPLETED
 *      if appropriate (passed OR 3 attempts exhausted).
 *
 * If the session is already in any non-IN_PROGRESS state (because somebody
 * else cleaned it up first), the script logs a no-op and exits 0.
 *
 * Usage:
 *   npx ts-node prisma/finish-stuck-session.ts cmp0jancx0008yp8eymv4iik3
 *
 * The session id is required as an argument so this script can never accidentally
 * touch the wrong row if it gets re-run.
 */
import {
  ExamSessionStatus,
  Prisma,
  PrismaClient,
  ProctorEventType,
  RegistrationStatus,
} from '@prisma/client';

const FULLSCREEN_WARNING_THRESHOLD = 3;
const MAX_ATTEMPTS = 3;
const STRIKES = 3;

async function main() {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error(
      'Usage: npx ts-node prisma/finish-stuck-session.ts <sessionId>',
    );
    process.exit(2);
  }

  const prisma = new PrismaClient();
  try {
    const before = await prisma.examSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        userId: true,
        certType: true,
        level: true,
        attemptNo: true,
        status: true,
        proctorWarnings: true,
        startedAt: true,
        hardDeadline: true,
        registrationId: true,
        failReason: true,
        user: { select: { name: true, email: true } },
      },
    });

    if (!before) {
      console.error(`Session ${sessionId} not found.`);
      process.exit(1);
    }

    console.log('── BEFORE ────────────────────────────────────────────');
    console.log(JSON.stringify(before, null, 2));

    if (before.status !== ExamSessionStatus.IN_PROGRESS) {
      console.log(
        `\nSession is already in terminal state ${before.status}. No changes made.`,
      );
      return;
    }

    const failReason = `Forced termination — voice/noise strike threshold reached (Article 28). Strikes: ${STRIKES}.`;

    const after = await prisma.$transaction(async (tx) => {
      const meta: Record<string, unknown> = {
        kind: 'VOICE_STRIKE_THRESHOLD',
        strikes: STRIKES,
        terminate: true,
        source: 'OPS_CLEANUP',
        note: 'one-off cleanup of session orphaned before voice-strike server termination shipped',
      };

      await tx.proctoringEvent.create({
        data: {
          sessionId: before.id,
          eventType: ProctorEventType.AUDIO_HIGH,
          metadata: meta as Prisma.InputJsonValue,
        },
      });

      const updated = await tx.examSession.update({
        where: { id: before.id },
        data: {
          status: ExamSessionStatus.TERMINATED,
          submittedAt: new Date(),
          failReason,
          proctorWarnings: Math.max(
            before.proctorWarnings,
            FULLSCREEN_WARNING_THRESHOLD,
          ),
        },
        select: {
          id: true,
          status: true,
          submittedAt: true,
          proctorWarnings: true,
          failReason: true,
          registrationId: true,
        },
      });

      return updated;
    });

    console.log('\n── AFTER ─────────────────────────────────────────────');
    console.log(JSON.stringify(after, null, 2));

    if (after.registrationId) {
      const regResult = await closeRegistrationIfFinished(
        prisma,
        after.registrationId,
      );
      console.log('\n── REGISTRATION CLOSE ────────────────────────────────');
      console.log(JSON.stringify(regResult, null, 2));
    } else {
      console.log(
        '\nSession has no registrationId (admin-only session). Skipping registration close.',
      );
    }

    console.log('\nDone.');
  } finally {
    await prisma.$disconnect();
  }
}

async function closeRegistrationIfFinished(
  prisma: PrismaClient,
  registrationId: string,
): Promise<{ closed: boolean; reason?: 'PASSED' | 'EXHAUSTED' }> {
  const reg = await prisma.registration.findUnique({
    where: { id: registrationId },
    select: { id: true, status: true },
  });
  if (!reg) return { closed: false };
  if (reg.status !== RegistrationStatus.PAID) {
    return { closed: false };
  }

  const sessions = await prisma.examSession.findMany({
    where: { registrationId },
    select: { status: true, passed: true },
  });
  const passed = sessions.some((s) => s.passed === true);
  const terminalCount = sessions.filter(
    (s) =>
      s.status === ExamSessionStatus.SUBMITTED ||
      s.status === ExamSessionStatus.GRADED ||
      s.status === ExamSessionStatus.TERMINATED,
  ).length;
  const exhausted = terminalCount >= MAX_ATTEMPTS;

  if (!passed && !exhausted) {
    return { closed: false };
  }

  const reason: 'PASSED' | 'EXHAUSTED' = passed ? 'PASSED' : 'EXHAUSTED';
  await prisma.registration.update({
    where: { id: registrationId },
    data: { status: RegistrationStatus.EXAM_COMPLETED },
  });
  return { closed: true, reason };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

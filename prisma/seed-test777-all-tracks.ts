/**
 * Ensures user `test777` has ONE takeable (PAID + CONFIRMED payment) exam
 * registration for EVERY track × level combination:
 *
 *   AXIS / AXIS_C / AXIS_H  ×  L3 / L2 / L1   = 9 registrations
 *
 * Each gets its own dedicated ONLINE_CBT schedule, marked idempotently via
 * venueDetail = `SEED_TEST777_ALL:<certType>:<level>`. Online exams have no
 * entry time-window gate (see CbtSessionsService.createFromRegistration), so
 * a PAID registration with a future examDeadline is immediately takeable.
 *
 * Re-running resets each registration back to PAID (so a finished/cancelled
 * one becomes takeable again) and refreshes the deadline.
 *
 * Run: npx ts-node prisma/seed-test777-all-tracks.ts
 *   EXAM_DATE_AFTER_PAYMENT=20  (deadline = now + N days, default 20)
 */
import {
  PrismaClient,
  CertType,
  CertLevel,
  ScheduleStatus,
  RegistrationStatus,
  PaymentStatus,
  PaymentMethod,
} from '@prisma/client';
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();

const MARKER_PREFIX = 'SEED_TEST777_ALL:';
const TARGET_USER_ID = 'test777';

const COMBOS: Array<[CertType, CertLevel]> = [
  [CertType.AXIS, CertLevel.L3],
  [CertType.AXIS, CertLevel.L2],
  [CertType.AXIS, CertLevel.L1],
  [CertType.AXIS_C, CertLevel.L3],
  [CertType.AXIS_C, CertLevel.L2],
  [CertType.AXIS_C, CertLevel.L1],
  [CertType.AXIS_H, CertLevel.L3],
  [CertType.AXIS_H, CertLevel.L2],
  [CertType.AXIS_H, CertLevel.L1],
];

function generateRegistrationNumber(
  certType: CertType,
  year: number,
  level: CertLevel,
  round: number,
  sequence: number,
): string {
  const certLabel = certType.replace('_', '-');
  const session = String(round).padStart(3, '0');
  const seq = String(sequence).padStart(4, '0');
  return `${certLabel}-${year}-${level}-${session}-${seq}`;
}

async function nextRound(certType: CertType, level: CertLevel, year: number): Promise<number> {
  const last = await prisma.examSchedule.findFirst({
    where: { certType, level, year },
    orderBy: { roundNumber: 'desc' },
  });
  return (last?.roundNumber ?? 0) + 1;
}

async function ensureSchedule(certType: CertType, level: CertLevel) {
  const venueDetail = `${MARKER_PREFIX}${certType}:${level}`;
  const existing = await prisma.examSchedule.findFirst({ where: { venueDetail } });
  if (existing) return existing;

  const examDate = new Date(Date.now() + 7 * 24 * 60 * 60_000);
  const year = examDate.getFullYear();
  const roundNumber = await nextRound(certType, level, year);
  const examStartTime = `${String(examDate.getHours()).padStart(2, '0')}:${String(
    examDate.getMinutes(),
  ).padStart(2, '0')}`;

  return prisma.examSchedule.create({
    data: {
      certType,
      level,
      year,
      roundNumber,
      examDate,
      examStartTime,
      registrationStart: new Date(),
      registrationEnd: new Date(Date.now() + 365 * 24 * 60 * 60_000),
      capacity: 9999,
      venue: 'ONLINE_CBT',
      venueDetail,
      status: ScheduleStatus.REGISTRATION_OPEN,
    },
  });
}

async function feeFor(certType: CertType, level: CertLevel): Promise<number> {
  const row = await prisma.certificationLevel.findFirst({
    where: { level, certification: { type: certType } },
  });
  return row?.fee ?? 100_000;
}

async function ensurePaidRegistration(userId: string, scheduleId: string, examDaysAfterPayment: number) {
  const schedule = await prisma.examSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
  const examDeadline = new Date(Date.now() + examDaysAfterPayment * 24 * 60 * 60_000);
  const amount = await feeFor(schedule.certType, schedule.level);

  return prisma.$transaction(async (tx) => {
    let r = await tx.registration.findUnique({
      where: { userId_scheduleId: { userId, scheduleId } },
    });
    let createdNew = false;

    if (!r) {
      const seq = (await tx.registration.count({ where: { scheduleId } })) + 1;
      const regNumber = generateRegistrationNumber(
        schedule.certType,
        schedule.year,
        schedule.level,
        schedule.roundNumber,
        seq,
      );
      r = await tx.registration.create({
        data: {
          userId,
          scheduleId,
          certType: schedule.certType,
          level: schedule.level,
          status: RegistrationStatus.PAID,
          registrationNumber: regNumber,
          seatHeldUntil: null,
          examDeadline,
        },
      });
      createdNew = true;
    } else {
      r = await tx.registration.update({
        where: { id: r.id },
        // Reset to PAID so a previously completed/cancelled seed reg becomes
        // takeable again on re-run.
        data: { status: RegistrationStatus.PAID, seatHeldUntil: null, examDeadline, cancelledAt: null },
      });
    }

    if (createdNew) {
      await tx.examSchedule.update({
        where: { id: scheduleId },
        data: { currentCount: { increment: 1 } },
      });
    }

    const pay = await tx.payment.findFirst({ where: { registrationId: r.id } });
    if (pay) {
      await tx.payment.update({
        where: { id: pay.id },
        data: { status: PaymentStatus.CONFIRMED, amount, method: PaymentMethod.CARD, approvedAt: new Date() },
      });
    } else {
      await tx.payment.create({
        data: {
          registrationId: r.id,
          orderId: `SEED777ALL_${randomBytes(10).toString('base64url')}`,
          amount,
          status: PaymentStatus.CONFIRMED,
          method: PaymentMethod.CARD,
          approvedAt: new Date(),
        },
      });
    }

    return r;
  });
}

async function main() {
  const examDays = parseInt(process.env.EXAM_DATE_AFTER_PAYMENT || '20', 10);

  const user = await prisma.user.findUnique({ where: { userId: TARGET_USER_ID } });
  if (!user) {
    console.error(`No user with user_id="${TARGET_USER_ID}". Create that account first.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Seeding 9 takeable registrations for ${TARGET_USER_ID} (${user.id})\n`);

  for (const [certType, level] of COMBOS) {
    const s = await ensureSchedule(certType, level);
    const r = await ensurePaidRegistration(user.id, s.id, examDays);

    // Keep schedule.currentCount honest.
    const c = await prisma.registration.count({
      where: {
        scheduleId: s.id,
        status: { notIn: [RegistrationStatus.CANCELLED, RegistrationStatus.REFUNDED] },
      },
    });
    await prisma.examSchedule.update({ where: { id: s.id }, data: { currentCount: c } });

    console.log(`  ✓ ${certType.replace('_', '-')} ${level}  reg=${r.id}  sched=${s.id}  (deadline +${examDays}d)`);
  }

  console.log(`\nDone. test777 can now sit one exam for every track × level.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

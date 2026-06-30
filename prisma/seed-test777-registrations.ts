/**
 * Ensures user `test777` has two PAID exam registrations (ready for CBT / MyPage).
 * Idempotent: uses fixed schedule venueDetail markers SEED_TEST777:1 and :2.
 *
 * Run: npx ts-node prisma/seed-test777-registrations.ts
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

const MARKER_PREFIX = 'SEED_TEST777:';
const TARGET_USER_ID = 'test777';

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

async function ensureSchedule(slot: '1' | '2', certType: CertType, level: CertLevel) {
  const venueDetail = `${MARKER_PREFIX}${slot}`;
  const existing = await prisma.examSchedule.findFirst({ where: { venueDetail } });
  if (existing) return existing;

  const examDate = new Date(Date.now() + 7 * 24 * 60 * 60_000);
  const year = examDate.getFullYear();
  const roundNumber = await nextRound(certType, level, year);
  const examStartTime = `${String(examDate.getHours()).padStart(2, '0')}:${String(
    examDate.getMinutes(),
  ).padStart(2, '0')}`;
  const registrationStart = new Date();
  const registrationEnd = new Date(Date.now() + 365 * 24 * 60 * 60_000);

  return prisma.examSchedule.create({
    data: {
      certType,
      level,
      year,
      roundNumber,
      examDate,
      examStartTime,
      registrationStart,
      registrationEnd,
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

async function ensurePaidRegistration(
  userId: string,
  scheduleId: string,
  examDaysAfterPayment: number,
) {
  const schedule = await prisma.examSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
  const examDeadline = new Date(Date.now() + examDaysAfterPayment * 24 * 60 * 60_000);
  const amount = await feeFor(schedule.certType, schedule.level);

  const existing = await prisma.registration.findUnique({
    where: { userId_scheduleId: { userId, scheduleId } },
  });
  if (existing?.status === RegistrationStatus.PAID) {
    const confirmed = await prisma.payment.findFirst({
      where: { registrationId: existing.id, status: PaymentStatus.CONFIRMED },
    });
    if (confirmed) {
      await prisma.registration.update({
        where: { id: existing.id },
        data: { examDeadline },
      });
      return existing;
    }
  }

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
        data: {
          status: RegistrationStatus.PAID,
          seatHeldUntil: null,
          examDeadline,
          cancelledAt: null,
        },
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
        data: {
          status: PaymentStatus.CONFIRMED,
          amount,
          method: PaymentMethod.CARD,
          approvedAt: new Date(),
        },
      });
    } else {
      await tx.payment.create({
        data: {
          registrationId: r.id,
          orderId: `SEED777_${randomBytes(10).toString('base64url')}`,
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

  const s1 = await ensureSchedule('1', CertType.AXIS, CertLevel.L3);
  const s2 = await ensureSchedule('2', CertType.AXIS_C, CertLevel.L3);

  const r1 = await ensurePaidRegistration(user.id, s1.id, examDays);
  const r2 = await ensurePaidRegistration(user.id, s2.id, examDays);

  for (const s of [s1, s2]) {
    const c = await prisma.registration.count({
      where: {
        scheduleId: s.id,
        status: { notIn: [RegistrationStatus.CANCELLED, RegistrationStatus.REFUNDED] },
      },
    });
    await prisma.examSchedule.update({ where: { id: s.id }, data: { currentCount: c } });
  }

  console.log(`OK — ${TARGET_USER_ID} (${user.id})`);
  console.log(`  Registration 1: ${r1.id}  schedule ${s1.id}  ${s1.certType} ${s1.level}`);
  console.log(`  Registration 2: ${r2.id}  schedule ${s2.id}  ${s2.certType} ${s2.level}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

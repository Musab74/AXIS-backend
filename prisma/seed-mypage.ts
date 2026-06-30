/**
 * Seeds sample registrations, payments, exam sessions and results for the
 * first user in the database. Designed to populate the MyPage dashboard with
 * real, end-to-end data so the UI can be exercised without a manual flow.
 *
 * Idempotent: re-runnable without producing duplicates.
 */
import {
  PrismaClient,
  RegistrationStatus,
  PaymentStatus,
  PaymentMethod,
  ExamSessionStatus,
  ExamPart,
  Prisma,
} from '@prisma/client';
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();

function regNumber(year: number, round: number) {
  return `R-${year}-${String(round).padStart(2, '0')}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

async function main() {
  const user = await prisma.user.findFirst();
  if (!user) {
    console.log('No user in DB — skipping. Sign up at least one user first.');
    return;
  }
  console.log(`Seeding MyPage data for user ${user.userId} (${user.id})…`);

  const certLevels = await prisma.certificationLevel.findMany({
    include: { certification: true },
  });
  const fee = (certType: string, level: string) =>
    certLevels.find((l) => l.certification.type === certType && l.level === level)?.fee ?? 0;

  const schedules = await prisma.examSchedule.findMany({ orderBy: { examDate: 'asc' } });
  if (schedules.length === 0) {
    console.log('No schedules in DB — run seed-schedules first.');
    return;
  }

  const past = schedules.filter((s) => s.examDate.getTime() < Date.now());
  const future = schedules.filter((s) => s.examDate.getTime() >= Date.now());

  const pastL3 = past.find((s) => s.level === 'L3');
  const pastL2 = past.find((s) => s.level === 'L2');
  const futureAxisL3 = future.find((s) => s.certType === 'AXIS' && s.level === 'L3');
  const futureAxisL2 = future.find((s) => s.certType === 'AXIS' && s.level === 'L2');
  const futureAxisCL3 = future.find((s) => s.certType === 'AXIS_C' && s.level === 'L3');

  // ── 1. Past completed exam — PASSED (drives "Taken" + "Certificates")
  if (pastL3) {
    const reg = await upsertRegistration(user.id, pastL3.id, RegistrationStatus.EXAM_COMPLETED);
    await ensurePayment(reg.id, PaymentStatus.CONFIRMED, fee(pastL3.certType, pastL3.level));
    await ensureGradedSession(user.id, reg.id, pastL3, {
      written: 82,
      practical: null,
      passed: true,
    });
  }

  // ── 2. Past completed exam — PARTIAL PASS (drives "Partial Pass")
  if (pastL2) {
    const reg = await upsertRegistration(user.id, pastL2.id, RegistrationStatus.EXAM_COMPLETED);
    await ensurePayment(reg.id, PaymentStatus.CONFIRMED, fee(pastL2.certType, pastL2.level));
    await ensureGradedSession(user.id, reg.id, pastL2, {
      written: 68,
      practical: 52,
      passed: false,
    });
  }

  // ── 3. Future confirmed (paid) registration — drives "Confirmed Exams" / Schedule
  if (futureAxisL3) {
    const reg = await upsertRegistration(user.id, futureAxisL3.id, RegistrationStatus.PAID);
    await ensurePayment(reg.id, PaymentStatus.CONFIRMED, fee(futureAxisL3.certType, futureAxisL3.level));
  }

  // ── 4. Future awaiting-payment registration — drives "Pay First" badge
  if (futureAxisL2) {
    const reg = await upsertRegistration(user.id, futureAxisL2.id, RegistrationStatus.PENDING_PAYMENT);
    // Create a PENDING payment row to mirror the real /payments/ready flow
    await ensurePayment(reg.id, PaymentStatus.PENDING, fee(futureAxisL2.certType, futureAxisL2.level));
  }

  // ── 5. Cancelled / refunded registration — drives "Cancelled" tile
  if (futureAxisCL3) {
    const reg = await upsertRegistration(user.id, futureAxisCL3.id, RegistrationStatus.REFUNDED);
    await ensurePayment(reg.id, PaymentStatus.REFUNDED, fee(futureAxisCL3.certType, futureAxisCL3.level), true);
  }

  // Refresh schedule.currentCount based on non-cancelled registrations
  for (const s of schedules) {
    const c = await prisma.registration.count({
      where: {
        scheduleId: s.id,
        status: { notIn: [RegistrationStatus.CANCELLED, RegistrationStatus.REFUNDED] },
      },
    });
    await prisma.examSchedule.update({ where: { id: s.id }, data: { currentCount: c } });
  }

  console.log('MyPage sample data seeded.');
}

async function upsertRegistration(
  userId: string,
  scheduleId: string,
  status: RegistrationStatus,
) {
  const existing = await prisma.registration.findUnique({
    where: { userId_scheduleId: { userId, scheduleId } },
  });
  const sched = await prisma.examSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
  if (existing) {
    return prisma.registration.update({
      where: { id: existing.id },
      data: {
        status,
        cancelledAt:
          status === RegistrationStatus.CANCELLED || status === RegistrationStatus.REFUNDED
            ? new Date()
            : null,
      },
    });
  }
  return prisma.registration.create({
    data: {
      userId,
      scheduleId,
      certType: sched.certType,
      level: sched.level,
      status,
      registrationNumber: regNumber(sched.year, sched.roundNumber),
      cancelledAt:
        status === RegistrationStatus.CANCELLED || status === RegistrationStatus.REFUNDED
          ? new Date()
          : null,
    },
  });
}

async function ensurePayment(
  registrationId: string,
  status: PaymentStatus,
  amount: number,
  refunded = false,
) {
  const existing = await prisma.payment.findFirst({ where: { registrationId } });
  const data = {
    amount,
    status,
    method: status === PaymentStatus.PENDING ? null : PaymentMethod.CARD,
    approvedAt: status === PaymentStatus.PENDING ? null : new Date(),
    refundAmount: refunded ? amount : null,
    refundReason: refunded ? 'Sample data — refunded' : null,
    cancelledAt: refunded ? new Date() : null,
  };
  if (existing) {
    return prisma.payment.update({ where: { id: existing.id }, data });
  }
  return prisma.payment.create({
    data: {
      registrationId,
      orderId: `AXIS_SEED_${randomBytes(8).toString('base64url')}`,
      ...data,
    },
  });
}

async function ensureGradedSession(
  userId: string,
  registrationId: string,
  schedule: { id: string; certType: 'AXIS' | 'AXIS_C' | 'AXIS_H'; level: 'L3' | 'L2' | 'L1'; examDate: Date },
  scores: { written: number; practical: number | null; passed: boolean },
) {
  const existing = await prisma.examSession.findFirst({
    where: { userId, registrationId, certType: schedule.certType, level: schedule.level },
  });
  const total =
    scores.practical == null
      ? scores.written
      : Math.round((scores.written + scores.practical) / 2);
  const failParts: string[] = [];
  if (!scores.passed) {
    if (scores.practical != null && scores.practical < 60)
      failParts.push(`Practical below 60% (${scores.practical}%).`);
    if (scores.written < 60) failParts.push(`Written below 60% (${scores.written}%).`);
  }
  const sessionData = {
    userId,
    registrationId,
    certType: schedule.certType,
    level: schedule.level,
    attemptNo: 1,
    status: ExamSessionStatus.GRADED,
    paperSeed: 'seeded',
    startedAt: schedule.examDate,
    submittedAt: new Date(schedule.examDate.getTime() + 60 * 60_000),
    writtenScore: scores.written,
    practicalScore: scores.practical,
    totalScore: total,
    passed: scores.passed,
    failReason: failParts.join(' ') || null,
  };
  const session = existing
    ? await prisma.examSession.update({ where: { id: existing.id }, data: sessionData })
    : await prisma.examSession.create({ data: sessionData });

  // Subject breakdown — mirrors the seed-exam shape so the UI shows realistic rows
  await prisma.gradingResult.deleteMany({ where: { sessionId: session.id } });
  const writtenSubjects = subjectsForLevel(schedule.certType, schedule.level, scores.written);
  const breakdown: Prisma.GradingResultCreateManyInput[] = writtenSubjects.map((sub, i) => ({
    sessionId: session.id,
    part: ExamPart.WRITTEN,
    subjectIndex: i,
    subjectName: sub.name,
    earned: sub.earned,
    total: sub.total,
    percentage: Math.round((sub.earned / sub.total) * 100),
    subjectFailed: sub.earned / sub.total < 0.4,
  }));
  if (scores.practical != null) {
    breakdown.push({
      sessionId: session.id,
      part: ExamPart.PRACTICAL,
      subjectIndex: 0,
      subjectName: 'AI hands-on tasks',
      earned: scores.practical,
      total: 100,
      percentage: scores.practical,
      subjectFailed: false,
    });
  }
  await prisma.gradingResult.createMany({ data: breakdown });
  return session;
}

function subjectsForLevel(certType: string, level: string, totalPct: number) {
  // Single-subject equivalent rendering — split the total roughly evenly.
  // Real exams have multi-subject breakdowns; this is enough for MyPage.
  const subjectCount = level === 'L3' ? 3 : 2;
  const labels =
    certType === 'AXIS_C'
      ? ['AI Coding Concepts', 'Prompt-to-Code', 'Coding Ethics']
      : certType === 'AXIS_H'
      ? ['Healthcare AI', 'Generative AI', 'Healthcare Tools']
      : ['AI Fundamentals', 'Prompt Design', 'AI Ethics'];
  const totalPerSubject = 50;
  const totalPoints = subjectCount * totalPerSubject;
  const earnedPoints = Math.round((totalPct / 100) * totalPoints);
  const subjects: { name: string; earned: number; total: number }[] = [];
  let remaining = earnedPoints;
  for (let i = 0; i < subjectCount; i++) {
    const earned = i === subjectCount - 1 ? remaining : Math.round(earnedPoints / subjectCount);
    subjects.push({ name: labels[i], earned, total: totalPerSubject });
    remaining -= earned;
  }
  return subjects;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

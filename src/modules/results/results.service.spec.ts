import { CertLevel, CertType, ScheduleStatus } from '@prisma/client';
import { ResultsService } from './results.service';

describe('ResultsService.listPublicRounds', () => {
  const prisma = {
    examSchedule: { findMany: jest.fn() },
    registration: { groupBy: jest.fn() },
    $queryRaw: jest.fn(),
  };

  function svc() {
    return new ResultsService(prisma as never, {} as never);
  }

  function daysFromNow(days: number): Date {
    return new Date(Date.now() + days * 24 * 60 * 60_000);
  }

  let seq = 0;
  function schedule(overrides: {
    examDate: Date;
    status?: ScheduleStatus;
    id?: string;
  }) {
    seq += 1;
    return {
      id: overrides.id ?? `sched-${seq}`,
      certType: CertType.AXIS,
      level: CertLevel.L3,
      roundNumber: seq,
      year: overrides.examDate.getFullYear(),
      examDate: overrides.examDate,
      status: overrides.status ?? ScheduleStatus.UPCOMING,
    };
  }

  /** registrations.groupBy rows for schedules with confirmed registrations */
  function regCounts(counts: Record<string, number>) {
    prisma.registration.groupBy.mockResolvedValue(
      Object.entries(counts).map(([scheduleId, n]) => ({
        scheduleId,
        _count: { _all: n },
      })),
    );
  }

  /** $queryRaw rows: latest-attempt pass/fail aggregates per schedule */
  function gradedCounts(rows: Record<string, { pass: number; fail: number }>) {
    prisma.$queryRaw.mockResolvedValue(
      Object.entries(rows).map(([scheduleId, r]) => ({
        scheduleId,
        passCount: BigInt(r.pass),
        failCount: BigInt(r.fail),
      })),
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    seq = 0;
    prisma.registration.groupBy.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);
  });

  it('hides past schedules that have zero confirmed registrations', async () => {
    const deadSlot = schedule({ id: 'dead', examDate: daysFromNow(-3) });
    const realPast = schedule({ id: 'real', examDate: daysFromNow(-3) });
    const future = schedule({ id: 'future', examDate: daysFromNow(3) });
    prisma.examSchedule.findMany.mockResolvedValue([future, deadSlot, realPast]);
    regCounts({ real: 12 });

    const res = await svc().listPublicRounds({ page: 1, pageSize: 10 });

    const ids = res.items.map((i) => i.scheduleId);
    expect(ids).toContain('real');
    expect(ids).toContain('future');
    expect(ids).not.toContain('dead');
  });

  it('caps upcoming rounds to the 15 nearest, soonest first', async () => {
    const schedules = Array.from({ length: 20 }, (_, i) =>
      schedule({ id: `up-${i + 1}`, examDate: daysFromNow(i + 1) }),
    );
    prisma.examSchedule.findMany.mockResolvedValue(schedules);

    const res = await svc().listPublicRounds({ page: 1, pageSize: 50 });

    expect(res.total).toBe(15);
    expect(res.items[0].scheduleId).toBe('up-1');
    expect(res.items[14].scheduleId).toBe('up-15');
    expect(res.items.map((i) => i.scheduleId)).not.toContain('up-16');
  });

  it('caps past (grading/announced) rounds to the 50 most recent', async () => {
    const schedules = Array.from({ length: 60 }, (_, i) =>
      schedule({ id: `past-${i + 1}`, examDate: daysFromNow(-(i + 1)) }),
    );
    prisma.examSchedule.findMany.mockResolvedValue(schedules);
    regCounts(Object.fromEntries(schedules.map((s) => [s.id, 5])));

    const res = await svc().listPublicRounds({ page: 1, pageSize: 50 });

    expect(res.total).toBe(50);
    // Most recent first; the 10 oldest fall off.
    expect(res.items[0].scheduleId).toBe('past-1');
    expect(res.items.map((i) => i.scheduleId)).not.toContain('past-51');
  });

  it('filters by publication status and exposes counts only when announced', async () => {
    const announced = schedule({
      id: 'done',
      examDate: daysFromNow(-10),
      status: ScheduleStatus.COMPLETED,
    });
    const grading = schedule({ id: 'grading', examDate: daysFromNow(-2) });
    const upcoming = schedule({ id: 'up', examDate: daysFromNow(5) });
    prisma.examSchedule.findMany.mockResolvedValue([announced, grading, upcoming]);
    regCounts({ done: 30, grading: 20 });
    gradedCounts({ done: { pass: 18, fail: 12 } });

    const all = await svc().listPublicRounds({ page: 1, pageSize: 10 });
    expect(all.items.map((i) => i.scheduleId)).toEqual(['up', 'grading', 'done']);

    const doneRow = all.items.find((i) => i.scheduleId === 'done');
    expect(doneRow).toMatchObject({
      publicationState: 'announced',
      passCount: 18,
      failCount: 12,
    });
    const gradingRow = all.items.find((i) => i.scheduleId === 'grading');
    expect(gradingRow).toMatchObject({
      publicationState: 'grading',
      passCount: null,
      failCount: null,
    });

    const onlyAnnounced = await svc().listPublicRounds({
      status: 'announced',
      page: 1,
      pageSize: 10,
    });
    expect(onlyAnnounced.items.map((i) => i.scheduleId)).toEqual(['done']);

    const onlyGrading = await svc().listPublicRounds({
      status: 'grading',
      page: 1,
      pageSize: 10,
    });
    expect(onlyGrading.items.map((i) => i.scheduleId)).toEqual(['grading']);

    const onlyUpcoming = await svc().listPublicRounds({
      status: 'upcoming',
      page: 1,
      pageSize: 10,
    });
    expect(onlyUpcoming.items.map((i) => i.scheduleId)).toEqual(['up']);
  });

  it('passes the exam-date range through to the schedule query', async () => {
    prisma.examSchedule.findMany.mockResolvedValue([]);
    const from = new Date('2026-06-01T00:00:00+09:00');
    const to = new Date('2026-06-30T23:59:59.999+09:00');

    await svc().listPublicRounds({ examDateFrom: from, examDateTo: to, page: 1, pageSize: 10 });

    expect(prisma.examSchedule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ examDate: { gte: from, lte: to } }),
      }),
    );
  });
});

import { BadRequestException } from '@nestjs/common';
import { CertLevel, CertType, Prisma, ScheduleStatus } from '@prisma/client';
import {
  SchedulesService,
  computeL3SlotRoundNumber,
} from './schedules.service';

describe('computeL3SlotRoundNumber', () => {
  it('maps the same date+hour to a stable round in the L3 slot range', () => {
    const a = computeL3SlotRoundNumber('2026-06-15', 10);
    const b = computeL3SlotRoundNumber('2026-06-15', 10);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(1001);
    expect(a).toBeLessThanOrEqual(9999);
  });

  it('assigns different rounds to different hours on the same day', () => {
    const morning = computeL3SlotRoundNumber('2026-06-15', 9);
    const later = computeL3SlotRoundNumber('2026-06-15', 10);
    expect(later).toBe(morning + 1);
  });

  it('rejects hours outside business hours', () => {
    expect(() => computeL3SlotRoundNumber('2026-06-15', 8)).toThrow(BadRequestException);
    expect(() => computeL3SlotRoundNumber('2026-06-15', 18)).toThrow(BadRequestException);
  });
});

describe('SchedulesService.findOrCreateForSlot', () => {
  const prisma = {
    examSchedule: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  };
  const redis = {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
  };

  function svc() {
    return new SchedulesService(prisma as never, redis as never);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an existing row matched by date and start time', async () => {
    const existing = {
      id: 'sched-existing',
      certType: CertType.AXIS,
      level: CertLevel.L3,
      roundNumber: 1050,
    };
    prisma.examSchedule.findFirst.mockResolvedValueOnce(existing);

    const result = await svc().findOrCreateForSlot({
      certType: CertType.AXIS,
      level: CertLevel.L3,
      dateIso: '2026-06-15',
      hour: 10,
    });

    expect(result).toBe(existing);
    expect(prisma.examSchedule.upsert).not.toHaveBeenCalled();
  });

  it('upserts with a deterministic round when the slot row is missing', async () => {
    prisma.examSchedule.findFirst.mockResolvedValueOnce(null);
    const upserted = {
      id: 'sched-new',
      certType: CertType.AXIS,
      level: CertLevel.L3,
      year: 2026,
      roundNumber: computeL3SlotRoundNumber('2026-06-15', 10),
      examStartTime: '10:00',
      status: ScheduleStatus.REGISTRATION_OPEN,
    };
    prisma.examSchedule.upsert.mockResolvedValueOnce(upserted);
    prisma.examSchedule.findUnique.mockResolvedValueOnce({
      ...upserted,
      capacity: 9999,
      currentCount: 0,
    });

    const result = await svc().findOrCreateForSlot({
      certType: CertType.AXIS,
      level: CertLevel.L3,
      dateIso: '2026-06-15',
      hour: 10,
    });

    expect(result).toBe(upserted);
    expect(prisma.examSchedule.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          certType_level_year_roundNumber: {
            certType: CertType.AXIS,
            level: CertLevel.L3,
            year: 2026,
            roundNumber: computeL3SlotRoundNumber('2026-06-15', 10),
          },
        },
        update: {},
      }),
    );
  });

  it('recovers when a concurrent caller wins the upsert race (P2002)', async () => {
    prisma.examSchedule.findFirst.mockResolvedValueOnce(null);

    const winning = {
      id: 'sched-race-winner',
      certType: CertType.AXIS,
      level: CertLevel.L3,
      year: 2026,
      roundNumber: computeL3SlotRoundNumber('2026-06-15', 10),
      examStartTime: '10:00',
      status: ScheduleStatus.REGISTRATION_OPEN,
      capacity: 9999,
      currentCount: 0,
    };

    const p2002 = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['exam_schedules_cert_type_level_year_round_number_key'] },
      },
    );
    prisma.examSchedule.upsert.mockRejectedValueOnce(p2002);
    // First findUnique recovers the row created by the racing caller; second
    // satisfies warmSeatCache().
    prisma.examSchedule.findUnique.mockResolvedValueOnce(winning);
    prisma.examSchedule.findUnique.mockResolvedValueOnce(winning);

    const result = await svc().findOrCreateForSlot({
      certType: CertType.AXIS,
      level: CertLevel.L3,
      dateIso: '2026-06-15',
      hour: 10,
    });

    expect(result).toBe(winning);
  });
});

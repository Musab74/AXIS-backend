import { NotFoundException } from '@nestjs/common';
import {
  AccountStatus,
  CertLevel,
  CertType,
  ExamSessionStatus,
  PaymentMethod,
  PaymentStatus,
  PenaltyStatus,
  RegistrationStatus,
  ScheduleStatus,
} from '@prisma/client';
import { AdminUsersService } from './admin-users.service';
import type { CertificatesService } from '../certificates/certificates.service';
import type { PrismaService } from '../../common/prisma.service';

type Mock<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? jest.Mock<R, A> : T[K];
};

/* eslint-disable @typescript-eslint/no-explicit-any */

function makePrismaMock() {
  const userFindMany = jest.fn();
  const userFindUnique = jest.fn();
  const userCount = jest.fn();
  const regFindMany = jest.fn();
  const regCount = jest.fn();
  const sessionFindMany = jest.fn();
  const $transaction = jest.fn(async (calls: any[]) => Promise.all(calls));
  const $queryRawUnsafe = jest.fn(async () => []);

  const prisma = {
    user: { findMany: userFindMany, findUnique: userFindUnique, count: userCount },
    registration: { findMany: regFindMany, count: regCount },
    examSession: { findMany: sessionFindMany },
    $transaction,
    $queryRawUnsafe,
  } as unknown as PrismaService;

  return {
    prisma,
    userFindMany,
    userFindUnique,
    userCount,
    regFindMany,
    regCount,
    sessionFindMany,
    $transaction: $transaction as unknown as jest.Mock,
    $queryRawUnsafe: $queryRawUnsafe as unknown as jest.Mock,
  };
}

function makeCertsMock() {
  return {
    listMine: jest.fn(async () => []),
  } as unknown as Mock<CertificatesService>;
}

const NOW = new Date('2026-05-09T10:00:00.000Z');

function makeUser(overrides: Partial<{ id: string; name: string; phone: string; email: string | null }> = {}) {
  return {
    id: overrides.id ?? 'user-1',
    userId: 'lee.seojun',
    name: overrides.name ?? '이서준',
    phone: overrides.phone ?? '010-1111-2222',
    email: overrides.email ?? 'lee@test.com',
    accountStatus: AccountStatus.ACTIVE,
    niceVerified: true,
    birthDate: '1995-01-01',
    gender: 'M',
    createdAt: NOW,
    lastLoginAt: NOW,
  };
}

function makeSchedule(overrides: Partial<{ id: string; certType: CertType; level: CertLevel }> = {}) {
  return {
    id: overrides.id ?? 'sched-1',
    certType: overrides.certType ?? CertType.AXIS,
    level: overrides.level ?? CertLevel.L2,
    year: 2026,
    roundNumber: 6,
    examDate: new Date('2026-06-01T00:00:00.000Z'),
    examStartTime: '14:00',
    status: ScheduleStatus.UPCOMING,
    venue: 'ONLINE_CBT',
    registrationStart: new Date('2026-04-01'),
    registrationEnd: new Date('2026-05-25'),
    capacity: 200,
    currentCount: 1,
    venueDetail: null,
    isHolidayWarning: false,
    cancelledAt: null,
    cancelReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makePayment(overrides: Partial<{ id: string; status: PaymentStatus; amount: number }> = {}) {
  return {
    id: overrides.id ?? 'pay-1',
    registrationId: 'reg-1',
    orderId: 'AXIS_xyz',
    paymentKey: 'tps_abc',
    amount: overrides.amount ?? 100_000,
    method: PaymentMethod.CARD,
    status: overrides.status ?? PaymentStatus.CONFIRMED,
    approvedAt: NOW,
    cancelledAt: null,
    refundAmount: null,
    refundReason: null,
    rawResponse: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeRegistration(
  overrides: Partial<{
    id: string;
    status: RegistrationStatus;
    user: ReturnType<typeof makeUser>;
    payments: ReturnType<typeof makePayment>[];
    schedule: ReturnType<typeof makeSchedule>;
  }> = {},
) {
  return {
    id: overrides.id ?? 'reg-1',
    userId: (overrides.user ?? makeUser()).id,
    scheduleId: (overrides.schedule ?? makeSchedule()).id,
    certType: CertType.AXIS,
    level: CertLevel.L2,
    status: overrides.status ?? RegistrationStatus.PAID,
    registrationNumber: 'AXIS-2026-L2-006-0001',
    seatNumber: null,
    partialExempt: false,
    exemptSourceSessionId: null,
    seatHeldUntil: null,
    examDeadline: null,
    supportDocUrl: null,
    cancelledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    user: overrides.user ?? makeUser(),
    schedule: overrides.schedule ?? makeSchedule(),
    payments: overrides.payments ?? [makePayment()],
  };
}

function makeSession(
  overrides: Partial<{
    id: string;
    registrationId: string | null;
    status: ExamSessionStatus;
    passed: boolean | null;
  }> = {},
) {
  return {
    id: overrides.id ?? 'sess-1',
    userId: 'user-1',
    registrationId: overrides.registrationId ?? 'reg-1',
    certType: CertType.AXIS,
    level: CertLevel.L2,
    attemptNo: 1,
    status: overrides.status ?? ExamSessionStatus.CREATED,
    paperSeed: null,
    startedAt: null,
    hardDeadline: null,
    submittedAt: null,
    totalScore: null,
    writtenScore: null,
    practicalScore: null,
    passed: overrides.passed ?? null,
    failReason: null,
    proctorWarnings: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeService() {
  const m = makePrismaMock();
  const certs = makeCertsMock();
  const loginAudit = { getLoginHistory: jest.fn(async () => []) };
  const redis = { get: jest.fn(async () => null) };
  const authSessions = { revokeSession: jest.fn(async () => undefined) };
  const svc = new AdminUsersService(
    m.prisma,
    certs as unknown as CertificatesService,
    loginAudit as never,
    redis as never,
    authSessions as never,
  );
  return { svc, ...m, certs };
}

describe('AdminUsersService.listExaminees', () => {
  it('paginates registration-driven status (REFUNDED) at the DB layer', async () => {
    const { svc, regFindMany, regCount, sessionFindMany } = makeService();
    regFindMany.mockResolvedValue([
      makeRegistration({ status: RegistrationStatus.REFUNDED }),
    ]);
    regCount.mockResolvedValue(7);
    sessionFindMany.mockResolvedValue([]);

    const res = await svc.listExaminees({ status: 'REFUNDED', page: 2, limit: 5 });

    expect(res.total).toBe(7);
    expect(res.page).toBe(2);
    expect(res.limit).toBe(5);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].examineeStatus).toBe('REFUNDED');

    const args = regFindMany.mock.calls[0][0];
    expect(args.where.status).toEqual({ in: [RegistrationStatus.REFUNDED] });
    expect(args.skip).toBe(5); // (page 2 - 1) * limit 5
    expect(args.take).toBe(5);
  });

  it('post-filters when status is session-driven (TERMINATED)', async () => {
    const { svc, regFindMany, regCount, sessionFindMany } = makeService();
    const reg1 = makeRegistration({ id: 'r1', status: RegistrationStatus.PAID });
    const reg2 = makeRegistration({ id: 'r2', status: RegistrationStatus.PAID });
    regFindMany.mockResolvedValue([reg1, reg2]);
    regCount.mockResolvedValue(2);
    sessionFindMany.mockResolvedValue([
      makeSession({ id: 's1', registrationId: 'r1', status: ExamSessionStatus.TERMINATED }),
      makeSession({ id: 's2', registrationId: 'r2', status: ExamSessionStatus.IN_PROGRESS }),
    ]);

    const res = await svc.listExaminees({ status: 'TERMINATED' });

    expect(res.items).toHaveLength(1);
    expect(res.items[0].registrationId).toBe('r1');
    expect(res.items[0].examineeStatus).toBe('TERMINATED');
    expect(res.items[0].refundable).toBe(false);

    // Default page/limit echoed back from the DTO defaults.
    expect(res.page).toBe(1);
    expect(res.limit).toBe(20);
    // Wide candidate window (POST_FILTER_FETCH_CAP = 1000) was used.
    expect(regFindMany.mock.calls[0][0].take).toBe(1_000);
    expect(regFindMany.mock.calls[0][0].skip).toBe(0);
  });

  it('search by name OR phone is forwarded to the user.OR clause', async () => {
    const { svc, regFindMany, regCount, sessionFindMany } = makeService();
    regFindMany.mockResolvedValue([]);
    regCount.mockResolvedValue(0);
    sessionFindMany.mockResolvedValue([]);

    await svc.listExaminees({ q: '010-1234' });

    const where = regFindMany.mock.calls[0][0].where;
    expect(where.user).toEqual({
      OR: [
        { name: { contains: '010-1234' } },
        { phone: { contains: '010-1234' } },
      ],
    });
  });

  it('refundable=true when registration is PAID and no session has started', async () => {
    const { svc, regFindMany, regCount, sessionFindMany } = makeService();
    const reg = makeRegistration({ status: RegistrationStatus.PAID });
    regFindMany.mockResolvedValue([reg]);
    regCount.mockResolvedValue(1);
    sessionFindMany.mockResolvedValue([]); // no session at all

    const res = await svc.listExaminees({});

    expect(res.items).toHaveLength(1);
    expect(res.items[0].refundable).toBe(true);
    expect(res.items[0].examineeStatus).toBe('NOT_STARTED');
  });

  it('refundable=false when latest session is IN_PROGRESS', async () => {
    const { svc, regFindMany, regCount, sessionFindMany } = makeService();
    const reg = makeRegistration({ status: RegistrationStatus.PAID });
    regFindMany.mockResolvedValue([reg]);
    regCount.mockResolvedValue(1);
    sessionFindMany.mockResolvedValue([
      makeSession({ registrationId: 'reg-1', status: ExamSessionStatus.IN_PROGRESS }),
    ]);

    const res = await svc.listExaminees({});

    expect(res.items[0].refundable).toBe(false);
    expect(res.items[0].examineeStatus).toBe('IN_PROGRESS');
  });

  it('CERTIFIED wins over GRADED_PASSED when a certificate row exists', async () => {
    const { svc, regFindMany, regCount, sessionFindMany, $queryRawUnsafe } = makeService();
    const reg = makeRegistration({ status: RegistrationStatus.EXAM_COMPLETED });
    regFindMany.mockResolvedValue([reg]);
    regCount.mockResolvedValue(1);
    sessionFindMany.mockResolvedValue([
      makeSession({
        id: 'sess-graded',
        registrationId: 'reg-1',
        status: ExamSessionStatus.GRADED,
        passed: true,
      }),
    ]);
    $queryRawUnsafe.mockResolvedValue([{ session_id: 'sess-graded' }]);

    const res = await svc.listExaminees({});

    expect(res.items[0].certified).toBe(true);
    expect(res.items[0].examineeStatus).toBe('CERTIFIED');
  });
});

describe('AdminUsersService.getExamineeDetail', () => {
  it('returns 404 NotFound when the user does not exist', async () => {
    const { svc, userFindUnique } = makeService();
    userFindUnique.mockResolvedValue(null);
    await expect(svc.getExamineeDetail('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('aggregates registrations + sessions + certificates + penalties', async () => {
    const { svc, userFindUnique, sessionFindMany, $queryRawUnsafe, certs } = makeService();
    const reg = makeRegistration();
    userFindUnique.mockResolvedValue({
      ...makeUser(),
      penalties: [
        {
          id: 'pen-1',
          reason: 'cheating',
          status: PenaltyStatus.ACTIVE,
          startAt: NOW,
          endAt: new Date('2027-05-09'),
          releasedAt: null,
          releaseReason: null,
          sessionId: 'sess-1',
          decidedBy: 'admin',
        },
      ],
      registrations: [reg],
    });
    sessionFindMany.mockResolvedValue([makeSession({ registrationId: 'reg-1' })]);
    $queryRawUnsafe.mockResolvedValue([]); // no certificates yet
    (certs.listMine as jest.Mock).mockResolvedValue([
      {
        id: 'cert-1',
        certNumber: 'AXIS-2026-L2-006-00001',
        userId: 'user-1',
        sessionId: 'sess-1',
        registrationId: 'reg-1',
        certType: 'AXIS',
        level: 'L2',
        holderName: '이서준',
        holderUserId: 'lee.seojun',
        holderBirthDate: null,
        issuedAt: NOW,
        validUntil: new Date('2029-05-09'),
        totalScore: 88,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);

    const res = await svc.getExamineeDetail('user-1');

    expect(res.user.name).toBe('이서준');
    expect(res.activePenaltyCount).toBe(1);
    expect(res.registrations).toHaveLength(1);
    expect(res.registrations[0].sessions).toHaveLength(1);
    expect(res.registrations[0].refundable).toBe(true);
    expect(res.certificates).toHaveLength(1);
    expect(res.certificates[0].certNumber).toBe('AXIS-2026-L2-006-00001');
    expect(res.penalties[0].status).toBe(PenaltyStatus.ACTIVE);
  });
});

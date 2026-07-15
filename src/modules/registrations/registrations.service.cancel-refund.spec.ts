import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  CertLevel,
  CertType,
  ExamSessionStatus,
  PaymentMethod,
  PaymentStatus,
  RegistrationStatus,
  ScheduleStatus,
} from '@prisma/client';
import { RegistrationsService } from './registrations.service';
import type { PrismaService } from '../../common/prisma.service';
import type { PortoneGateway } from '../payments/portone-gateway.interface';
import type { SchedulesService } from '../schedules/schedules.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NOW = Date.now();

function makePrismaMock() {
  const regFindUnique = jest.fn();
  const sessionFindFirst = jest.fn<Promise<unknown>, unknown[]>(async () => null);
  const $transaction = jest.fn(async (calls: any[]) => Promise.all(calls));
  const paymentUpdate = jest.fn(async () => ({}));
  const registrationUpdate = jest.fn(async () => ({}));
  const examScheduleUpdate = jest.fn(async () => ({}));

  const prisma = {
    registration: {
      findUnique: regFindUnique,
      update: registrationUpdate,
    },
    examSession: { findFirst: sessionFindFirst },
    payment: { update: paymentUpdate },
    examSchedule: { update: examScheduleUpdate },
    $transaction,
  } as unknown as PrismaService;

  return {
    prisma,
    regFindUnique,
    sessionFindFirst,
    paymentUpdate,
    registrationUpdate,
    examScheduleUpdate,
  };
}

function makeRegistration(
  overrides: Partial<{
    status: RegistrationStatus;
    paymentStatus: PaymentStatus;
    examDateOffsetDays: number;
    regEndOffsetDays: number;
    paymentAmount: number;
    userId: string;
  }> = {},
) {
  const examDate = new Date(NOW + (overrides.examDateOffsetDays ?? 30) * 86_400_000);
  const regEnd = new Date(NOW + (overrides.regEndOffsetDays ?? 20) * 86_400_000);
  return {
    id: 'reg-1',
    userId: overrides.userId ?? 'user-1',
    scheduleId: 'sched-1',
    certType: CertType.AXIS,
    level: CertLevel.L2,
    status: overrides.status ?? RegistrationStatus.PAID,
    registrationNumber: 'AXIS-2026-L2-006-0001',
    schedule: {
      id: 'sched-1',
      certType: CertType.AXIS,
      level: CertLevel.L2,
      year: 2026,
      roundNumber: 6,
      examDate,
      examStartTime: '14:00',
      registrationStart: new Date(NOW - 30 * 86_400_000),
      registrationEnd: regEnd,
      capacity: 200,
      currentCount: 1,
      status: ScheduleStatus.UPCOMING,
      venue: 'ONLINE_CBT',
    },
    payments: [
      {
        id: 'pay-1',
        registrationId: 'reg-1',
        orderId: 'AXIS_xyz',
        paymentKey: 'tps_abc',
        amount: overrides.paymentAmount ?? 100_000,
        method: PaymentMethod.CARD,
        status: overrides.paymentStatus ?? PaymentStatus.CONFIRMED,
      },
    ],
  };
}

function makeService() {
  const m = makePrismaMock();
  const portone = { cancelPayment: jest.fn(async () => ({})) };
  const schedules = {} as unknown as SchedulesService;
  const ncp = { signedGetUrl: jest.fn(async () => 'https://signed') };
  const redis = {
    get: jest.fn(async () => null),
    incr: jest.fn(async () => 1),
    set: jest.fn(async () => undefined),
    isReady: jest.fn(() => true),
  };
  const mailer = { send: jest.fn(async () => 'SENT' as const) };
  const config = { get: jest.fn(() => undefined) };
  const svc = new RegistrationsService(
    m.prisma,
    portone as unknown as PortoneGateway,
    schedules,
    ncp as never,
    redis as never,
    mailer as never,
    config as never,
  );
  return { svc, ...m, portone };
}

describe('RegistrationsService.cancelWithRefund — session gate', () => {
  it('rejects with Conflict when an IN_PROGRESS session exists', async () => {
    const { svc, regFindUnique, sessionFindFirst } = makeService();
    regFindUnique.mockResolvedValue(makeRegistration());
    sessionFindFirst.mockResolvedValue({
      id: 'sess-1',
      status: ExamSessionStatus.IN_PROGRESS,
    });
    await expect(svc.cancelWithRefund('user-1', 'reg-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects with Conflict when a SUBMITTED session exists', async () => {
    const { svc, regFindUnique, sessionFindFirst } = makeService();
    regFindUnique.mockResolvedValue(makeRegistration());
    sessionFindFirst.mockResolvedValue({
      id: 'sess-1',
      status: ExamSessionStatus.SUBMITTED,
    });
    await expect(svc.cancelWithRefund('user-1', 'reg-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects with Conflict when a TERMINATED session exists', async () => {
    const { svc, regFindUnique, sessionFindFirst } = makeService();
    regFindUnique.mockResolvedValue(makeRegistration());
    sessionFindFirst.mockResolvedValue({
      id: 'sess-1',
      status: ExamSessionStatus.TERMINATED,
    });
    await expect(svc.cancelWithRefund('user-1', 'reg-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('proceeds with a tiered refund when no started session exists', async () => {
    const { svc, regFindUnique, sessionFindFirst, portone } = makeService();
    regFindUnique.mockResolvedValue(
      makeRegistration({ examDateOffsetDays: 30, regEndOffsetDays: 20 }),
    );
    sessionFindFirst.mockResolvedValue(null);
    const res = await svc.cancelWithRefund('user-1', 'reg-1');
    expect(res.refundTier).toBe('FULL');
    expect(res.refundAmount).toBe(100_000);
    expect(portone.cancelPayment).toHaveBeenCalledTimes(1);
  });

  it('rejects with Forbidden when the caller is not the owner', async () => {
    const { svc, regFindUnique } = makeService();
    regFindUnique.mockResolvedValue(makeRegistration({ userId: 'other-user' }));
    await expect(svc.cancelWithRefund('user-1', 'reg-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('throws NotFound when the registration is missing', async () => {
    const { svc, regFindUnique } = makeService();
    regFindUnique.mockResolvedValue(null);
    await expect(svc.cancelWithRefund('user-1', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

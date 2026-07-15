import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
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
const ACTOR = { id: 'admin-1', name: 'Super Admin' };

function makePrismaMock() {
  const regFindUnique = jest.fn();
  const sessionFindFirst = jest.fn();
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
    $transaction: $transaction as unknown as jest.Mock,
  };
}

function makePortoneMock() {
  return { cancelPayment: jest.fn(async () => ({ cancellation: { id: 'cancel-1' } })) };
}

function makeSchedulesMock() {
  return {} as unknown as SchedulesService;
}

function makeRegistration(
  overrides: Partial<{
    status: RegistrationStatus;
    paymentStatus: PaymentStatus;
    examDateOffsetDays: number;
    regEndOffsetDays: number;
    paymentAmount: number;
  }> = {},
) {
  const examDate = new Date(NOW + (overrides.examDateOffsetDays ?? 30) * 86_400_000);
  const regEnd = new Date(NOW + (overrides.regEndOffsetDays ?? 20) * 86_400_000);
  return {
    id: 'reg-1',
    userId: 'user-1',
    scheduleId: 'sched-1',
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
    createdAt: new Date(),
    updatedAt: new Date(),
    user: { id: 'user-1', name: '이서준' },
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
      venueDetail: null,
      isHolidayWarning: false,
      cancelledAt: null,
      cancelReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
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
        approvedAt: new Date(),
        cancelledAt: null,
        refundAmount: null,
        refundReason: null,
        rawResponse: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  };
}

function makeService() {
  const m = makePrismaMock();
  const portone = makePortoneMock();
  const schedules = makeSchedulesMock();
  const ncp = { signedGetUrl: jest.fn(async () => 'https://signed') };
  const redis = { get: jest.fn(async () => null), incr: jest.fn(async () => 1), set: jest.fn(async () => undefined) };
  const svc = new RegistrationsService(
    m.prisma,
    portone as unknown as PortoneGateway,
    schedules,
    ncp as never,
    redis as never,
  );
  return { svc, ...m, portone };
}

describe('RegistrationsService.adminRefund', () => {
  it('rejects with BadRequest when reason is empty', async () => {
    const { svc } = makeService();
    await expect(
      svc.adminRefund('reg-1', { mode: 'FULL', reason: '   ' }, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws NotFound when registration is missing', async () => {
    const { svc, regFindUnique } = makeService();
    regFindUnique.mockResolvedValue(null);
    await expect(
      svc.adminRefund('missing', { mode: 'FULL', reason: 'goodwill' }, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns alreadyCancelled idempotently for REFUNDED registrations', async () => {
    const { svc, regFindUnique } = makeService();
    regFindUnique.mockResolvedValue(makeRegistration({ status: RegistrationStatus.REFUNDED }));
    const res = await svc.adminRefund('reg-1', { mode: 'FULL', reason: 'redo' }, ACTOR);
    expect(res).toEqual({ ok: true, alreadyCancelled: true, refundAmount: 0 });
  });

  it('rejects EXAM_COMPLETED registrations with BadRequest', async () => {
    const { svc, regFindUnique } = makeService();
    regFindUnique.mockResolvedValue(
      makeRegistration({ status: RegistrationStatus.EXAM_COMPLETED }),
    );
    await expect(
      svc.adminRefund('reg-1', { mode: 'FULL', reason: 'late' }, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects with Conflict when an in-progress session blocks refund', async () => {
    const { svc, regFindUnique, sessionFindFirst } = makeService();
    regFindUnique.mockResolvedValue(makeRegistration());
    sessionFindFirst.mockResolvedValue({
      id: 'sess-1',
      status: ExamSessionStatus.IN_PROGRESS,
    });
    await expect(
      svc.adminRefund('reg-1', { mode: 'TIERED', reason: 'try' }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('FULL mode refunds 100% regardless of timing (inside 7-day window)', async () => {
    const { svc, regFindUnique, sessionFindFirst, portone, paymentUpdate, registrationUpdate } =
      makeService();
    // Exam is 3 days away → tiered policy would say NONE; FULL must override.
    regFindUnique.mockResolvedValue(
      makeRegistration({ examDateOffsetDays: 3, regEndOffsetDays: -1 }),
    );
    sessionFindFirst.mockResolvedValue(null);

    const res = await svc.adminRefund(
      'reg-1',
      { mode: 'FULL', reason: 'system outage compensation' },
      ACTOR,
    );

    expect(res).toMatchObject({ ok: true, refundAmount: 100_000, refundTier: 'ADMIN_FULL' });
    expect(portone.cancelPayment).toHaveBeenCalledWith(
      'tps_abc',
      expect.stringContaining('[ADMIN:admin-1]'),
      100_000,
      undefined,
    );
    expect(paymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pay-1' },
        data: expect.objectContaining({
          status: 'REFUNDED',
          refundAmount: 100_000,
          refundReason: expect.stringContaining('[ADMIN:admin-1]'),
        }),
      }),
    );
    expect(registrationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'reg-1' },
        data: expect.objectContaining({ status: RegistrationStatus.REFUNDED }),
      }),
    );
  });

  it('rejects DEMO- payment keys with BadRequest (no PortOne cancel)', async () => {
    const { svc, regFindUnique, sessionFindFirst, portone } = makeService();
    const reg = makeRegistration({ examDateOffsetDays: 30, regEndOffsetDays: 20 });
    reg.payments[0].paymentKey = 'DEMO-AXIS_xyz-1700000000000';
    regFindUnique.mockResolvedValue(reg);
    sessionFindFirst.mockResolvedValue(null);

    await expect(
      svc.adminRefund('reg-1', { mode: 'FULL', reason: 'oops' }, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(portone.cancelPayment).not.toHaveBeenCalled();
  });

  it('TIERED mode applies the user-side policy (FULL when before reg-end)', async () => {
    const { svc, regFindUnique, sessionFindFirst, portone } = makeService();
    regFindUnique.mockResolvedValue(
      makeRegistration({ examDateOffsetDays: 30, regEndOffsetDays: 20 }),
    );
    sessionFindFirst.mockResolvedValue(null);

    const res = await svc.adminRefund(
      'reg-1',
      { mode: 'TIERED', reason: 'user request' },
      ACTOR,
    );

    expect(res.refundTier).toBe('FULL');
    expect(res.refundAmount).toBe(100_000);
    expect(portone.cancelPayment).toHaveBeenCalledTimes(1);
  });

  it('TIERED mode → NONE within the 7-day window does not call PortOne cancel', async () => {
    const { svc, regFindUnique, sessionFindFirst, portone } = makeService();
    regFindUnique.mockResolvedValue(
      makeRegistration({ examDateOffsetDays: 3, regEndOffsetDays: -2 }),
    );
    sessionFindFirst.mockResolvedValue(null);

    const res = await svc.adminRefund(
      'reg-1',
      { mode: 'TIERED', reason: 'too late' },
      ACTOR,
    );

    expect(res.refundTier).toBe('NONE');
    expect(res.refundAmount).toBe(0);
    expect(portone.cancelPayment).not.toHaveBeenCalled();
  });

  it('cancels with no refund when there is no confirmed payment', async () => {
    const { svc, regFindUnique, sessionFindFirst, portone } = makeService();
    regFindUnique.mockResolvedValue(
      makeRegistration({
        status: RegistrationStatus.PENDING_PAYMENT,
        paymentStatus: PaymentStatus.PENDING,
      }),
    );
    sessionFindFirst.mockResolvedValue(null);

    const res = await svc.adminRefund(
      'reg-1',
      { mode: 'FULL', reason: 'cleanup' },
      ACTOR,
    );

    expect(res).toEqual({ ok: true, refundAmount: 0, refundTier: 'NO_PAYMENT' });
    expect(portone.cancelPayment).not.toHaveBeenCalled();
  });
});

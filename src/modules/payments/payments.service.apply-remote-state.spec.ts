import type { ConfigService } from '@nestjs/config';
import { PaymentStatus, RegistrationStatus } from '@prisma/client';
import { PaymentsService } from './payments.service';
import type { PortonePaymentLike } from './portone-payment.types';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('PaymentsService.applyRemoteState — single money-path for webhook + cron', () => {
  const prisma = {
    payment: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    registration: { update: jest.fn() },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
  };
  const config = {
    get: jest.fn((k: string) => (k === 'exam.daysAfterPayment' ? 20 : undefined)),
  } as unknown as ConfigService;
  const redis = {
    setNxEx: jest.fn(async () => true),
    isReady: jest.fn(() => true),
  };
  const notifications = { notify: jest.fn(async () => null) };

  const svc = () =>
    new PaymentsService(prisma as never, config, redis as never, notifications as never);

  const remotePaid = (total = 100_000): PortonePaymentLike => ({
    id: 'imp_remote',
    status: 'PAID',
    amount: { total },
  });

  const pendingPayment = (over = {}) => ({
    id: 'pay-1',
    orderId: 'AXIS-r1-1',
    registrationId: 'reg-1',
    amount: 100_000,
    status: PaymentStatus.PENDING,
    paymentKey: null,
    rawResponse: null,
    registration: {
      id: 'reg-1',
      status: RegistrationStatus.PENDING_PAYMENT,
      certType: 'AXIS',
      level: 'L3',
      supportDocUrl: null,
      eligibilityStatus: 'NOT_REQUIRED',
      schedule: { currentCount: 5, capacity: 10 },
    },
    ...over,
  });

  beforeEach(() => jest.clearAllMocks());

  it('PAID with matching amount confirms the payment and flips the registration', async () => {
    prisma.payment.findFirst.mockResolvedValueOnce(pendingPayment());

    const outcome = await svc().applyRemoteState(
      { orderId: 'AXIS-r1-1', amount: 100_000 },
      remotePaid(),
    );

    expect(outcome).toBe('PAID');
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PaymentStatus.CONFIRMED,
          paymentKey: 'imp_remote',
        }),
      }),
    );
    expect(prisma.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: RegistrationStatus.PAID }),
      }),
    );
  });

  it('PAID with a mismatched amount is SKIPPED — no state change', async () => {
    const outcome = await svc().applyRemoteState(
      { orderId: 'AXIS-r1-1', amount: 100_000 },
      remotePaid(50_000),
    );
    expect(outcome).toBe('SKIPPED');
    expect(prisma.payment.findFirst).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  it('PAID over capacity leaves the payment PENDING and force-alerts admins', async () => {
    prisma.payment.findFirst.mockResolvedValueOnce(
      pendingPayment({
        registration: {
          ...pendingPayment().registration,
          schedule: { currentCount: 11, capacity: 10 },
        },
      }),
    );

    const outcome = await svc().applyRemoteState(
      { orderId: 'AXIS-r1-1', amount: 100_000 },
      remotePaid(),
    );

    expect(outcome).toBe('PAID');
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ force: true, severity: 'HIGH' }),
    );
  });

  it('CANCELLED cancels the payment and a still-pending registration', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce(pendingPayment());

    const outcome = await svc().applyRemoteState(
      { orderId: 'AXIS-r1-1', amount: 100_000 },
      { id: 'imp_remote', status: 'CANCELLED', amount: { total: 100_000 } },
    );

    expect(outcome).toBe('CANCELLED');
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PaymentStatus.CANCELLED }),
      }),
    );
    expect(prisma.registration.update).toHaveBeenCalled();
  });

  it('FAILED only flips a PENDING payment row', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce(
      pendingPayment({ status: PaymentStatus.CONFIRMED }),
    );
    const outcome = await svc().applyRemoteState(
      { orderId: 'AXIS-r1-1', amount: 100_000 },
      { id: 'imp_remote', status: 'FAILED', amount: { total: 100_000 } },
    );
    expect(outcome).toBe('FAILED');
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  it('VIRTUAL_ACCOUNT_ISSUED persists the PG id, and is idempotent on re-sweep', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce(pendingPayment());
    const remote: PortonePaymentLike = {
      id: 'imp_remote',
      status: 'VIRTUAL_ACCOUNT_ISSUED',
      amount: { total: 100_000 },
      method: { type: 'PaymentMethodVirtualAccount', accountNumber: '111', bank: 'KOOKMIN' },
    };

    expect(await svc().applyRemoteState({ orderId: 'AXIS-r1-1', amount: 100_000 }, remote)).toBe(
      'VA_ISSUED',
    );
    expect(prisma.payment.update).toHaveBeenCalledTimes(1);

    // Second sweep: paymentKey + rawResponse already persisted → no write.
    prisma.payment.findUnique.mockResolvedValueOnce(
      pendingPayment({ paymentKey: 'imp_remote', rawResponse: { id: 'imp_remote' } }),
    );
    expect(await svc().applyRemoteState({ orderId: 'AXIS-r1-1', amount: 100_000 }, remote)).toBe(
      'VA_ISSUED',
    );
    expect(prisma.payment.update).toHaveBeenCalledTimes(1);
  });

  it('unknown remote status is SKIPPED', async () => {
    const outcome = await svc().applyRemoteState(
      { orderId: 'AXIS-r1-1', amount: 100_000 },
      { id: 'imp_remote', status: 'READY', amount: { total: 100_000 } },
    );
    expect(outcome).toBe('SKIPPED');
  });
});

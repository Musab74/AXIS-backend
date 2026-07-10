import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PaymentStatus, RegistrationStatus } from '@prisma/client';
import { PortoneApplyService } from './portone-apply.service';
import type { PortoneGateway } from './portone-gateway.interface';
import type { PaymentsService } from './payments.service';

describe('PortoneApplyService', () => {
  const prisma = {
    payment: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    registration: { findUnique: jest.fn(), update: jest.fn() },
    certificationLevel: { findFirst: jest.fn() },
    examSchedule: { update: jest.fn() },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
  };

  const redis = { set: jest.fn(async () => undefined) };

  const configKeys: Record<string, string | number> = {
    'portone.moduleVersion': 'v2',
    'portone.v2ApiSecret': 'unit_test_secret_value',
    'portone.storeId': 'store-unit',
    'portone.channelKey': 'channel-unit',
    'portone.webhookSecret': 'webhook-unit',
    'exam.daysAfterPayment': 20,
  };

  const config = {
    get: jest.fn((k: string) => configKeys[k] ?? ''),
  } as unknown as ConfigService;

  const mockGetPayment = jest.fn();
  const portoneGateway = {
    version: 'v2' as const,
    getPayment: mockGetPayment,
    cancelPayment: jest.fn(),
    verifyWebhook: jest.fn(async () => []),
  } as unknown as PortoneGateway;

  const payments = {
    applyPortOnePaid: jest.fn(async () => undefined),
    applyPortOneCancelled: jest.fn(async () => undefined),
    applyPortOneVaIssued: jest.fn(async () => undefined),
    applyPortOneFailed: jest.fn(async () => undefined),
    applyRemoteState: jest.fn(async () => 'PAID'),
  } as unknown as PaymentsService;

  function svc() {
    return new PortoneApplyService(
      prisma as never,
      config,
      redis as never,
      portoneGateway,
      payments,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('applyPaymentRequest', () => {
    const baseReg = {
      id: 'reg-1',
      userId: 'user-1',
      status: RegistrationStatus.PENDING_PAYMENT,
      certType: 'AXIS',
      level: 'L3',
      registrationNumber: 'REG001',
      supportDocUrl: null,
      seatHeldUntil: new Date(Date.now() + 600_000),
      scheduleId: 'sched-1',
      user: { name: 'Test', email: 't@example.com', phone: '010' },
      schedule: {},
    };

    it('reuses an existing PENDING payment without paymentKey', async () => {
      prisma.registration.findUnique.mockResolvedValueOnce(baseReg);
      prisma.certificationLevel.findFirst.mockResolvedValueOnce({ fee: 100_000 });
      prisma.payment.findFirst.mockResolvedValueOnce({
        id: 'pay-1',
        orderId: 'AXIS-reg-1-1',
        amount: 100_000,
        paymentKey: null,
        rawResponse: null,
      });

      const result = await svc().applyPaymentRequest('user-1', 'reg-1');

      expect(prisma.payment.create).not.toHaveBeenCalled();
      expect(result.merchantId).toBe('AXIS-reg-1-1');
      expect(result.alreadyIssued).toBe(false);
    });

    it('returns the existing PENDING row when create races on duplicate order_id', async () => {
      prisma.registration.findUnique.mockResolvedValueOnce(baseReg);
      prisma.certificationLevel.findFirst.mockResolvedValueOnce({ fee: 100_000 });
      prisma.payment.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'pay-race',
          orderId: 'AXIS-reg-1-ts',
          amount: 100_000,
          paymentKey: null,
          rawResponse: null,
        });
      const p2002 = new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['order_id'] },
      });
      prisma.payment.create.mockRejectedValueOnce(p2002);

      const result = await svc().applyPaymentRequest('user-1', 'reg-1');

      expect(result.merchantId).toBe('AXIS-reg-1-ts');
      expect(result.alreadyIssued).toBe(false);
    });
  });

  it('applyPaymentConfirm throws NotFound when order missing', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce(null);
    await expect(
      svc().applyPaymentConfirm('user-1', { paymentId: 'pid', merchantId: 'AXIS-x-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('applyPaymentConfirm throws Forbidden for wrong user', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce({
      id: 'pay1',
      orderId: 'AXIS-reg-9',
      amount: 100_000,
      status: PaymentStatus.PENDING,
      paymentKey: null,
      rawResponse: null,
      registrationId: 'reg1',
      registration: { userId: 'other-user', certType: 'AXIS', level: 'L3' },
    });
    await expect(
      svc().applyPaymentConfirm('user-1', { paymentId: 'pid', merchantId: 'AXIS-reg-9' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('applyPaymentConfirm throws amount_mismatch when PortOne total differs', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce({
      id: 'pay1',
      orderId: 'AXIS-reg-9',
      amount: 100_000,
      status: PaymentStatus.PENDING,
      paymentKey: null,
      rawResponse: null,
      registrationId: 'reg1',
      registration: { userId: 'user-1', certType: 'AXIS', level: 'L3' },
    });
    mockGetPayment.mockResolvedValueOnce({
      status: 'VIRTUAL_ACCOUNT_ISSUED',
      id: 'portone-remote-id',
      amount: { total: 50_000 },
      method: {
        type: 'PaymentMethodVirtualAccount',
        accountNumber: '1234567890',
        bank: 'KOOKMIN',
        expiredAt: '2026-12-31T00:00:00Z',
      },
    });
    try {
      await svc().applyPaymentConfirm('user-1', {
        paymentId: 'portone-remote-id',
        merchantId: 'AXIS-reg-9',
      });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as BadRequestException).getResponse()).toEqual(
        expect.objectContaining({ error: 'amount_mismatch' }),
      );
    }
  });

  it('applyPaymentConfirm returns VA_ISSUED and persists via PaymentsService', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce({
      id: 'pay1',
      orderId: 'AXIS-reg-9',
      amount: 100_000,
      status: PaymentStatus.PENDING,
      paymentKey: null,
      rawResponse: null,
      registrationId: 'reg1',
      registration: { userId: 'user-1', certType: 'AXIS', level: 'L3' },
    });
    const remote = {
      status: 'VIRTUAL_ACCOUNT_ISSUED',
      id: 'portone-remote-id',
      amount: { total: 100_000 },
      method: {
        type: 'PaymentMethodVirtualAccount',
        accountNumber: '1234567890',
        bank: 'KOOKMIN',
        expiredAt: '2026-12-31T00:00:00Z',
      },
    };
    mockGetPayment.mockResolvedValueOnce(remote);

    const result = await svc().applyPaymentConfirm('user-1', {
      paymentId: 'portone-remote-id',
      merchantId: 'AXIS-reg-9',
    });

    expect(result.status).toBe('VA_ISSUED');
    if (result.status !== 'VA_ISSUED') throw new Error('expected VA_ISSUED');
    expect(result.vbankNum).toBe('1234567890');
    expect(payments.applyPortOneVaIssued).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId: 'AXIS-reg-9',
        pgPaymentId: 'portone-remote-id',
      }),
    );
  });

  it('applyPaymentConfirm returns unexpected_status for cancelled payment', async () => {
    prisma.payment.findUnique.mockResolvedValueOnce({
      id: 'pay1',
      orderId: 'AXIS-reg-9',
      amount: 100_000,
      status: PaymentStatus.CANCELLED,
      paymentKey: null,
      rawResponse: null,
      registrationId: 'reg1',
      registration: { userId: 'user-1', certType: 'AXIS', level: 'L3' },
    });
    await expect(
      svc().applyPaymentConfirm('user-1', {
        paymentId: 'pid',
        merchantId: 'AXIS-reg-9',
      }),
    ).rejects.toMatchObject({
      response: { error: 'unexpected_status' },
    });
  });

  describe('verifyAndHandleWebhookPayload — webhooks are untrusted triggers', () => {
    it('applies the API-reported state, not the webhook-claimed type (spoofed cancel)', async () => {
      (portoneGateway.verifyWebhook as jest.Mock).mockResolvedValueOnce([
        { type: 'CANCELLED', merchantOrderId: 'AXIS-r1-1', transactionId: 'imp_1' },
      ]);
      // The PG API says the payment is actually PAID — the forged cancel must not win.
      mockGetPayment.mockResolvedValueOnce({
        id: 'imp_1',
        status: 'PAID',
        amount: { total: 100_000 },
      });
      prisma.payment.findFirst.mockResolvedValueOnce({
        orderId: 'AXIS-r1-1',
        amount: 100_000,
      });

      await svc().verifyAndHandleWebhookPayload('{}', {});

      expect(payments.applyRemoteState).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: 'AXIS-r1-1' }),
        expect.objectContaining({ status: 'PAID' }),
      );
      expect(payments.applyPortOneCancelled).not.toHaveBeenCalled();
    });

    it('changes nothing when the PG API cannot be reached', async () => {
      (portoneGateway.verifyWebhook as jest.Mock).mockResolvedValueOnce([
        { type: 'PAID', merchantOrderId: 'AXIS-r1-1', transactionId: 'imp_1' },
      ]);
      mockGetPayment.mockRejectedValue(new Error('network down'));

      await svc().verifyAndHandleWebhookPayload('{}', {});

      expect(payments.applyRemoteState).not.toHaveBeenCalled();
      expect(prisma.payment.findFirst).not.toHaveBeenCalled();
      mockGetPayment.mockReset();
    });

    it('warns and skips when no local payment matches the refs', async () => {
      (portoneGateway.verifyWebhook as jest.Mock).mockResolvedValueOnce([
        { type: 'PAID', merchantOrderId: 'UNKNOWN-1', transactionId: 'imp_x' },
      ]);
      mockGetPayment.mockResolvedValueOnce({
        id: 'imp_x',
        status: 'PAID',
        amount: { total: 100_000 },
      });
      prisma.payment.findFirst.mockResolvedValueOnce(null);

      await svc().verifyAndHandleWebhookPayload('{}', {});

      expect(payments.applyRemoteState).not.toHaveBeenCalled();
    });
  });

  describe('applyPaymentTestConfirm (demo bypass)', () => {
    it('throws NotFound when the registration does not exist', async () => {
      prisma.registration.findUnique.mockResolvedValueOnce(null);
      await expect(svc().applyPaymentTestConfirm('user-1', 'reg-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws Forbidden when the registration belongs to another user', async () => {
      prisma.registration.findUnique.mockResolvedValueOnce({
        id: 'reg-1',
        userId: 'other-user',
        status: RegistrationStatus.PENDING_PAYMENT,
      });
      await expect(svc().applyPaymentTestConfirm('user-1', 'reg-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('is idempotent — returns PAID without calling payments service when already PAID', async () => {
      prisma.registration.findUnique.mockResolvedValueOnce({
        id: 'reg-1',
        userId: 'user-1',
        status: RegistrationStatus.PAID,
      });
      const result = await svc().applyPaymentTestConfirm('user-1', 'reg-1');
      expect(result).toEqual({ ok: true, status: 'PAID', registrationId: 'reg-1' });
      expect(prisma.payment.findFirst).not.toHaveBeenCalled();
      expect(payments.applyPortOnePaid).not.toHaveBeenCalled();
    });

    it('throws Conflict for any status other than PENDING_PAYMENT or PAID', async () => {
      prisma.registration.findUnique.mockResolvedValueOnce({
        id: 'reg-1',
        userId: 'user-1',
        status: RegistrationStatus.CANCELLED,
      });
      await expect(svc().applyPaymentTestConfirm('user-1', 'reg-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('throws BadRequest when no pending Payment exists (request not called first)', async () => {
      prisma.registration.findUnique.mockResolvedValueOnce({
        id: 'reg-1',
        userId: 'user-1',
        status: RegistrationStatus.PENDING_PAYMENT,
      });
      prisma.payment.findFirst.mockResolvedValueOnce(null);
      await expect(svc().applyPaymentTestConfirm('user-1', 'reg-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('marks PAID via PaymentsService with a synthetic DEMO- pgPaymentId', async () => {
      prisma.registration.findUnique.mockResolvedValueOnce({
        id: 'reg-1',
        userId: 'user-1',
        status: RegistrationStatus.PENDING_PAYMENT,
      });
      prisma.payment.findFirst.mockResolvedValueOnce({
        id: 'pay-1',
        orderId: 'AXIS-reg-1-1700000000000',
        status: PaymentStatus.PENDING,
      });

      const result = await svc().applyPaymentTestConfirm('user-1', 'reg-1');

      expect(result).toEqual({ ok: true, status: 'PAID', registrationId: 'reg-1' });
      expect(payments.applyPortOnePaid).toHaveBeenCalledTimes(1);
      const arg = (payments.applyPortOnePaid as jest.Mock).mock.calls[0][0];
      expect(arg.merchantId).toBe('AXIS-reg-1-1700000000000');
      expect(arg.pgPaymentId).toMatch(/^DEMO-AXIS-reg-1-1700000000000-\d+$/);
      expect(arg.rawResponse).toEqual(
        expect.objectContaining({ demo: true, confirmedBy: 'test-confirm' }),
      );
    });
  });
});

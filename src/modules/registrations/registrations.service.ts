import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CertLevel,
  CertType,
  EligibilityStatus,
  ExamSessionStatus,
  PaymentStatus,
  Prisma,
  RegistrationStatus,
  ScheduleStatus,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../integrations/redis/redis.service';
import { NcObjectStorageService } from '../../integrations/ncObjectStorage/nc-object-storage.service';
import { MAX_ATTEMPTS } from '../cbtSessions/exam-spec';
import {
  BONUS_ATTEMPTS_KEY,
  getBonusAttempts,
  MAX_BONUS_ATTEMPTS,
} from '../cbtSessions/registration-bonus-attempts';
import { PORTONE_GATEWAY, PortoneGateway } from '../payments/portone-gateway.interface';
import { SchedulesService, parseVirtualSlotId } from '../schedules/schedules.service';
import { AdminRefundDto } from './dto/admin-refund.dto';
import { isPendingPaymentHoldExpired, SEAT_HOLD_MINUTES } from './seat-hold.util';
import {
  ELIG_REFUND_QUEUE_KEY,
  eligRefundDetailKey,
  type EligibilityRefundRequestRecord,
} from './eligibility-refund.constants';

export interface QuickBookDto {
  certType: CertType;
  level: CertLevel;
  examDate?: string;  // Optional - defaults to immediate start
}

const REFUND_HALF_DAYS = 7; // 7+ days before exam → 50% refund

/** AXIS-C L1 is the only cert/level combo that requires document review. */
const AXIS_C_L1_FILTER = { certType: CertType.AXIS_C, level: CertLevel.L1 } as const;

/** Map apply-wizard codes to the canonical values stored in DB. */
export function normalizeEligibilityType(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const map: Record<string, string> = {
    L2_CERT: 'L2_CERT',
    MANAGER_EXP: 'MANAGER_EXP',
    MGMT_2Y: 'MANAGER_EXP',
    PREP_COURSE: 'PREP_COURSE',
    AX_LEADER_COURSE: 'PREP_COURSE',
  };
  return map[raw] ?? raw;
}

function eligibilityDocFileName(key: string | null): string | null {
  if (!key) return null;
  const name = key.split('/').pop();
  return name && name.length > 0 ? name : null;
}

@Injectable()
export class RegistrationsService {
  private readonly auditLogger = new Logger('AdminAudit');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PORTONE_GATEWAY) private readonly portoneGateway: PortoneGateway,
    private readonly schedules: SchedulesService,
    private readonly ncp: NcObjectStorageService,
    private readonly redis: RedisService,
  ) {}

  // ─── L1 eligibility review ───────────────────────────────────────────────

  /**
   * L1 eligibility review list. With a `status` filter it returns exactly that
   * bucket; without one it returns ALL real L1 applicants (paid/completed, or
   * anyone who has uploaded a doc) regardless of review state — so admins always
   * see who needs review, not just rows already moved to PENDING.
   */
  async listEligibilityQueue(status?: 'PENDING' | 'APPROVED' | 'REJECTED') {
    const where: Prisma.RegistrationWhereInput = status
      ? { ...AXIS_C_L1_FILTER, eligibilityStatus: status as EligibilityStatus }
      : {
          ...AXIS_C_L1_FILTER,
          OR: [
            { status: { in: [RegistrationStatus.PAID, RegistrationStatus.EXAM_COMPLETED] } },
            { supportDocUrl: { not: null } },
            {
              eligibilityStatus: {
                in: [
                  EligibilityStatus.PENDING,
                  EligibilityStatus.APPROVED,
                  EligibilityStatus.REJECTED,
                ],
              },
            },
          ],
        };
    const rows = await this.prisma.registration.findMany({
      where,
      include: { user: { select: { name: true, userId: true } } },
      orderBy: [{ eligibilityStatus: 'asc' }, { updatedAt: 'desc' }],
    });
    return rows.map((r) => ({
      registrationId: r.id,
      registrationNumber: r.registrationNumber,
      candidate: r.user.name,
      candidateUserId: r.user.userId,
      certType: r.certType,
      level: r.level,
      eligibilityType: r.eligibilityType,
      eligibilityStatus: r.eligibilityStatus,
      hasDocument: !!r.supportDocUrl,
      documentFileName: eligibilityDocFileName(r.supportDocUrl),
      eligibilityNote: r.eligibilityNote,
      reviewedBy: r.eligibilityReviewedBy,
      reviewedAt: r.eligibilityReviewedAt,
      registrationStatus: r.status,
      createdAt: r.createdAt,
    }));
  }

  /** Pending AXIS-C L1 eligibility documents awaiting expert/admin review. */
  async countEligibilityPending(): Promise<{ pending: number }> {
    const pending = await this.prisma.registration.count({
      where: {
        ...AXIS_C_L1_FILTER,
        eligibilityStatus: EligibilityStatus.PENDING,
      },
    });
    return { pending };
  }

  /** Short-lived signed URL to view an applicant's uploaded eligibility document. */
  async getEligibilityDocUrl(
    registrationId: string,
  ): Promise<{ url: string | null; fileName: string | null }> {
    const reg = await this.prisma.registration.findUnique({ where: { id: registrationId } });
    if (!reg) throw new NotFoundException('Registration not found');
    const fileName = eligibilityDocFileName(reg.supportDocUrl);
    if (!reg.supportDocUrl) return { url: null, fileName: null };
    try {
      const url = await this.ncp.signedGetUrl(reg.supportDocUrl, 600, 'axis-docs');
      return { url, fileName };
    } catch {
      return { url: null, fileName };
    }
  }

  /** Persist the applicant-declared eligibility basis (AXIS-C L1 apply wizard). */
  async setEligibilityBasis(
    userId: string,
    registrationId: string,
    eligibilityType: string,
  ): Promise<{ ok: true }> {
    const reg = await this.prisma.registration.findUnique({ where: { id: registrationId } });
    if (!reg) throw new NotFoundException('Registration not found');
    if (reg.userId !== userId) throw new ForbiddenException('Not your registration');
    if (reg.certType !== CertType.AXIS_C || reg.level !== CertLevel.L1) {
      throw new BadRequestException('Eligibility basis applies to AXIS-C L1 only.');
    }
    const normalized = normalizeEligibilityType(eligibilityType);
    if (!normalized) throw new BadRequestException('eligibilityType is required');

    await this.prisma.registration.update({
      where: { id: registrationId },
      data: { eligibilityType: normalized },
    });
    return { ok: true };
  }

  /** Approve or reject an L1 eligibility document. Records the reviewer + note. */
  async reviewEligibility(
    actorId: string,
    registrationId: string,
    decision: 'APPROVED' | 'REJECTED',
    note?: string,
  ): Promise<{ ok: true; eligibilityStatus: string }> {
    const reg = await this.prisma.registration.findUnique({ where: { id: registrationId } });
    if (!reg) throw new NotFoundException('Registration not found');
    if (reg.certType !== CertType.AXIS_C || reg.level !== CertLevel.L1) {
      throw new BadRequestException('Eligibility review applies to AXIS-C L1 registrations only.');
    }
    if (reg.eligibilityStatus !== EligibilityStatus.PENDING) {
      throw new BadRequestException('Only pending submissions can be reviewed.');
    }
    if (decision === 'APPROVED' && !reg.supportDocUrl) {
      throw new BadRequestException('Cannot approve without an uploaded document.');
    }
    await this.prisma.registration.update({
      where: { id: registrationId },
      data: {
        eligibilityStatus: decision,
        eligibilityReviewedBy: actorId,
        eligibilityReviewedAt: new Date(),
        eligibilityNote: note ?? reg.eligibilityNote,
      },
    });
    return { ok: true, eligibilityStatus: decision };
  }

  /**
   * Candidate submits a 100% refund request (admin must approve before PortOne cancel).
   */
  async requestEligibilityRefund(
    userId: string,
    registrationId: string,
    candidateNote?: string,
  ): Promise<{ ok: true; status: 'REQUESTED'; requestedAt: string }> {
    if (!this.redis.isReady()) {
      throw new ConflictException(
        '환불 요청을 일시적으로 처리할 수 없습니다. 잠시 후 다시 시도하거나 고객센터에 문의해 주세요.',
      );
    }

    const reg = await this.prisma.registration.findUnique({
      where: { id: registrationId },
      include: {
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
        schedule: true,
        user: { select: { id: true, name: true, email: true } },
      },
    });
    this.assertEligibilityRefundEligible(reg, userId);

    const startedSession = await this.prisma.examSession.findFirst({
      where: { registrationId, startedAt: { not: null } },
    });
    if (startedSession) {
      throw new ConflictException('Cannot request refund after the exam has started');
    }

    const existing = await this.readEligibilityRefundRequest(registrationId);
    if (existing?.status === 'PENDING') {
      throw new ConflictException('이미 환불 요청이 접수되어 관리자 검토 중입니다.');
    }

    const confirmedPayment = reg!.payments.find((p) => p.status === PaymentStatus.CONFIRMED);
    const payload: EligibilityRefundRequestRecord = {
      registrationId,
      userId: reg!.userId,
      userName: reg!.user.name,
      userEmail: reg!.user.email,
      certType: reg!.certType,
      level: reg!.level,
      roundNumber: reg!.schedule.roundNumber,
      examDate: reg!.schedule.examDate.toISOString(),
      amount: confirmedPayment!.amount,
      eligibilityStatus: reg!.eligibilityStatus,
      eligibilityNote: reg!.eligibilityNote,
      requestedAt: new Date().toISOString(),
      status: 'PENDING',
      ...(candidateNote?.trim() ? { candidateNote: candidateNote.trim() } : {}),
    };

    await this.redis.set(eligRefundDetailKey(registrationId), JSON.stringify(payload));
    await this.redis.lpushTrim(ELIG_REFUND_QUEUE_KEY, registrationId, 500);

    return { ok: true, status: 'REQUESTED', requestedAt: payload.requestedAt };
  }

  async countEligibilityRefundPending(): Promise<{ pending: number }> {
    const rows = await this.listEligibilityRefundRequests('PENDING');
    return { pending: rows.length };
  }

  async listEligibilityRefundRequests(
    status: 'PENDING' | 'ALL' = 'PENDING',
  ): Promise<EligibilityRefundRequestRecord[]> {
    const ids = await this.redis.lrange(ELIG_REFUND_QUEUE_KEY, 0, 499);
    const uniqueIds = [...new Set(ids)];
    const rows: EligibilityRefundRequestRecord[] = [];
    for (const id of uniqueIds) {
      const row = await this.readEligibilityRefundRequest(id);
      if (!row) continue;
      if (status === 'PENDING' && row.status !== 'PENDING') continue;
      rows.push(row);
    }
    rows.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    return rows;
  }

  async approveEligibilityRefundRequest(
    actorId: string,
    registrationId: string,
    adminNote?: string,
  ): Promise<{ ok: true; refundAmount: number; refundTier: string }> {
    const pending = await this.readEligibilityRefundRequest(registrationId);
    if (!pending || pending.status !== 'PENDING') {
      throw new NotFoundException('Pending eligibility refund request not found');
    }

    const result = await this.executeEligibilityRefund(
      pending.userId,
      registrationId,
      `[ADMIN:${actorId}] Eligibility refund approved${adminNote ? ` — ${adminNote}` : ''}`,
    );

    const closed: EligibilityRefundRequestRecord = {
      ...pending,
      status: 'APPROVED',
      processedAt: new Date().toISOString(),
      processedBy: actorId,
      ...(adminNote?.trim() ? { adminNote: adminNote.trim() } : {}),
    };
    await this.redis.set(eligRefundDetailKey(registrationId), JSON.stringify(closed));
    await this.redis.lrem(ELIG_REFUND_QUEUE_KEY, 0, registrationId);

    return result;
  }

  async rejectEligibilityRefundRequest(
    actorId: string,
    registrationId: string,
    adminNote?: string,
  ): Promise<{ ok: true }> {
    const pending = await this.readEligibilityRefundRequest(registrationId);
    if (!pending || pending.status !== 'PENDING') {
      throw new NotFoundException('Pending eligibility refund request not found');
    }

    const closed: EligibilityRefundRequestRecord = {
      ...pending,
      status: 'REJECTED',
      processedAt: new Date().toISOString(),
      processedBy: actorId,
      adminNote: adminNote?.trim() || '관리자 반려',
    };
    await this.redis.set(eligRefundDetailKey(registrationId), JSON.stringify(closed));
    await this.redis.lrem(ELIG_REFUND_QUEUE_KEY, 0, registrationId);
    return { ok: true };
  }

  /** Executes PortOne cancel + DB updates after admin approval. */
  async executeEligibilityRefund(
    userId: string,
    registrationId: string,
    reasonOverride?: string,
  ): Promise<{ ok: true; refundAmount: number; refundTier: string }> {
    const reg = await this.prisma.registration.findUnique({
      where: { id: registrationId },
      include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 }, schedule: true },
    });
    if (!reg) throw new NotFoundException('Registration not found');
    if (reg.userId !== userId) throw new ForbiddenException('Not your registration');
    if (reg.certType !== CertType.AXIS_C || reg.level !== CertLevel.L1) {
      throw new BadRequestException('Eligibility refund only applies to AXIS-C L1');
    }
    if (reg.eligibilityStatus === EligibilityStatus.APPROVED) {
      throw new BadRequestException(
        'Cannot use eligibility refund — document is already approved.',
      );
    }
    if (
      reg.status === RegistrationStatus.CANCELLED ||
      reg.status === RegistrationStatus.REFUNDED
    ) {
      return { ok: true, refundAmount: 0, refundTier: 'ALREADY_REFUNDED' };
    }
    if (reg.status === RegistrationStatus.EXAM_COMPLETED) {
      throw new BadRequestException('Cannot refund a completed exam registration');
    }
    if (reg.status !== RegistrationStatus.PAID) {
      throw new BadRequestException('Refund is only available for paid registrations');
    }

    const startedSession = await this.prisma.examSession.findFirst({
      where: { registrationId, startedAt: { not: null } },
    });
    if (startedSession) {
      throw new ConflictException('Cannot refund after the exam has started');
    }

    const confirmedPayment = reg.payments.find((p) => p.status === PaymentStatus.CONFIRMED);
    if (!confirmedPayment) {
      throw new BadRequestException('No confirmed payment to refund');
    }

    const refundAmount = confirmedPayment.amount;
    const reasonByStatus: Record<EligibilityStatus, string> = {
      [EligibilityStatus.REJECTED]:
        '응시자격 서류 반려 — 100% 환불 (Eligibility rejected — full refund)',
      [EligibilityStatus.PENDING]:
        '응시자격 검토 대기 — 100% 환불 (Eligibility pending — full refund)',
      [EligibilityStatus.NOT_REQUIRED]:
        '응시자격 미승인 — 100% 환불 (Eligibility not approved — full refund)',
      [EligibilityStatus.APPROVED]: '',
    };
    const reason =
      reasonOverride ??
      reasonByStatus[reg.eligibilityStatus] ??
      'AXIS-C L1 응시자격 — 100% 환불';

    if (confirmedPayment.paymentKey) {
      await this.portoneGateway.cancelPayment(
        confirmedPayment.paymentKey,
        reason,
        refundAmount,
      );
    }

    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: confirmedPayment.id },
        data: {
          status: PaymentStatus.REFUNDED,
          refundAmount,
          refundReason: reason,
          cancelledAt: new Date(),
        },
      }),
      this.prisma.registration.update({
        where: { id: registrationId },
        data: { status: RegistrationStatus.REFUNDED, cancelledAt: new Date() },
      }),
      this.prisma.examSchedule.update({
        where: { id: reg.scheduleId },
        data: { currentCount: { decrement: 1 } },
      }),
    ]);

    return { ok: true, refundAmount, refundTier: 'ELIGIBILITY_FULL' };
  }

  /** @deprecated Direct refund — use {@link requestEligibilityRefund} + admin approve. */
  async refundEligibilityBlocked(userId: string, registrationId: string) {
    return this.executeEligibilityRefund(userId, registrationId);
  }

  /** @deprecated alias */
  async refundEligibilityRejected(userId: string, registrationId: string) {
    return this.executeEligibilityRefund(userId, registrationId);
  }

  private async readEligibilityRefundRequest(
    registrationId: string,
  ): Promise<EligibilityRefundRequestRecord | null> {
    const raw = await this.redis.get(eligRefundDetailKey(registrationId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as EligibilityRefundRequestRecord;
    } catch {
      return null;
    }
  }

  private assertEligibilityRefundEligible(
    reg: {
      userId: string;
      certType: CertType;
      level: CertLevel;
      eligibilityStatus: EligibilityStatus;
      status: RegistrationStatus;
      payments: { status: PaymentStatus; amount: number }[];
    } | null,
    userId: string,
  ): void {
    if (!reg) throw new NotFoundException('Registration not found');
    if (reg.userId !== userId) throw new ForbiddenException('Not your registration');
    if (reg.certType !== CertType.AXIS_C || reg.level !== CertLevel.L1) {
      throw new BadRequestException('Eligibility refund only applies to AXIS-C L1');
    }
    if (reg.eligibilityStatus === EligibilityStatus.APPROVED) {
      throw new BadRequestException(
        'Cannot request eligibility refund — your document is already approved.',
      );
    }
    if (
      reg.status === RegistrationStatus.CANCELLED ||
      reg.status === RegistrationStatus.REFUNDED
    ) {
      throw new BadRequestException('This registration is already cancelled or refunded');
    }
    if (reg.status !== RegistrationStatus.PAID) {
      throw new BadRequestException('Refund request is only available for paid registrations');
    }
    const confirmedPayment = reg.payments.find((p) => p.status === PaymentStatus.CONFIRMED);
    if (!confirmedPayment) {
      throw new BadRequestException('No confirmed payment to refund');
    }
  }

  /**
   * Pending-payment seat holds that passed `seatHeldUntil` are cancelled so
   * capacity frees and My Page no longer shows stale rows.
   */
  private async releaseExpiredSeatHolds(): Promise<void> {
    const now = new Date();
    const holdCutoff = new Date(now.getTime() - SEAT_HOLD_MINUTES * 60_000);
    const stale = await this.prisma.registration.findMany({
      where: {
        status: RegistrationStatus.PENDING_PAYMENT,
        OR: [{ seatHeldUntil: { lt: now } }, { seatHeldUntil: null, createdAt: { lt: holdCutoff } }],
      },
      select: { id: true, scheduleId: true },
      take: 200,
    });
    for (const row of stale) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const regUp = await tx.registration.updateMany({
            where: {
              id: row.id,
              status: RegistrationStatus.PENDING_PAYMENT,
              OR: [{ seatHeldUntil: { lt: now } }, { seatHeldUntil: null, createdAt: { lt: holdCutoff } }],
            },
            data: {
              status: RegistrationStatus.CANCELLED,
              cancelledAt: now,
              seatHeldUntil: null,
            },
          });
          if (regUp.count === 0) return;
          await tx.payment.updateMany({
            where: { registrationId: row.id, status: PaymentStatus.PENDING },
            data: { status: PaymentStatus.CANCELLED, cancelledAt: now },
          });
          await tx.examSchedule.update({
            where: { id: row.scheduleId },
            data: { currentCount: { decrement: 1 } },
          });
        });
      } catch (err) {
        this.auditLogger.warn(`releaseExpiredSeatHolds: skip ${row.id} — ${String(err)}`);
      }
    }
  }

  async listMine(userId: string) {
    await this.releaseExpiredSeatHolds();
    const regs = await this.prisma.registration.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        schedule: true,
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    const certLevels = await this.prisma.certificationLevel.findMany({
      include: { certification: true },
    });
    const feeLookup = new Map<string, number>();
    for (const lv of certLevels) {
      feeLookup.set(`${lv.certification.type}:${lv.level}`, lv.fee);
    }

    return Promise.all(
      regs.map(async (r) => {
        const refundReq = await this.readEligibilityRefundRequest(r.id);
        return {
      id: r.id,
      certType: r.certType,
      level: r.level,
      status: r.status,
      registrationNumber: r.registrationNumber,
      seatNumber: r.seatNumber,
      partialExempt: r.partialExempt,
      cancelledAt: r.cancelledAt,
      createdAt: r.createdAt,
      seatHeldUntil: r.seatHeldUntil,
      examDeadline: r.examDeadline,
      examDeadlineExpired: r.examDeadline ? new Date() > r.examDeadline : false,
      eligibilityStatus: r.eligibilityStatus,
      eligibilityNote: r.eligibilityNote,
      hasSupportDoc: !!r.supportDocUrl,
      eligibilityRefundRequested: refundReq?.status === 'PENDING',
      fee: feeLookup.get(`${r.certType}:${r.level}`) ?? null,
      schedule: {
        id: r.schedule.id,
        roundNumber: r.schedule.roundNumber,
        year: r.schedule.year,
        examDate: r.schedule.examDate,
        examStartTime: r.schedule.examStartTime,
        venue: r.schedule.venue,
        status: r.schedule.status,
      },
      latestPayment: r.payments[0]
        ? {
            id: r.payments[0].id,
            orderId: r.payments[0].orderId,
            amount: r.payments[0].amount,
            method: r.payments[0].method,
            status: r.payments[0].status,
            approvedAt: r.payments[0].approvedAt,
            refundAmount: r.payments[0].refundAmount,
          }
        : null,
        };
      }),
    );
  }

  async create(userId: string, scheduleId: string) {
    // Virtual on-demand slots (L1/L2/L3) are synthesized by /schedules/slots and
    // only become real ExamSchedule rows when a candidate registers —
    // materialize here before running the seat-hold/capacity checks below.
    const virtual = parseVirtualSlotId(scheduleId);
    if (virtual) {
      const materialized = await this.schedules.findOrCreateForSlot({
        certType: virtual.certType,
        level: virtual.level,
        dateIso: virtual.dateIso,
        hour: virtual.hour,
      });
      scheduleId = materialized.id;
    }
    await this.releaseExpiredSeatHolds();
    const schedule = await this.prisma.examSchedule.findUnique({ where: { id: scheduleId } });
    if (!schedule) throw new NotFoundException('Schedule not found');

    if (
      schedule.status !== ScheduleStatus.REGISTRATION_OPEN &&
      schedule.status !== ScheduleStatus.UPCOMING
    ) {
      throw new ConflictException(`Cannot register — schedule is ${schedule.status}`);
    }
    if (schedule.currentCount >= schedule.capacity) {
      throw new ConflictException('Schedule is full');
    }

    const existing = await this.prisma.registration.findUnique({
      where: { userId_scheduleId: { userId, scheduleId } },
    });
    if (existing && isPendingPaymentHoldExpired(existing, new Date())) {
      const now = new Date();
      await this.prisma.$transaction([
        this.prisma.payment.updateMany({
          where: { registrationId: existing.id, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.CANCELLED, cancelledAt: now },
        }),
        this.prisma.registration.update({
          where: { id: existing.id },
          data: {
            status: RegistrationStatus.CANCELLED,
            cancelledAt: now,
            seatHeldUntil: null,
          },
        }),
        this.prisma.examSchedule.update({
          where: { id: scheduleId },
          data: { currentCount: { decrement: 1 } },
        }),
      ]);
    } else if (existing && existing.status !== RegistrationStatus.CANCELLED) {
      throw new ConflictException('Already registered');
    }

    const seatHeldUntil = new Date(Date.now() + SEAT_HOLD_MINUTES * 60_000);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const regSequence = (await tx.registration.count({
          where: { scheduleId },
        })) + 1;
        const regNumber = this.generateRegistrationNumber(
          schedule.certType,
          schedule.year,
          schedule.level,
          schedule.roundNumber,
          regSequence,
        );
        const reg = existing
          ? await tx.registration.update({
              where: { id: existing.id },
              data: {
                status: RegistrationStatus.PENDING_PAYMENT,
                cancelledAt: null,
                seatHeldUntil,
              },
              include: { schedule: true },
            })
          : await tx.registration.create({
              data: {
                userId,
                scheduleId,
                certType: schedule.certType,
                level: schedule.level,
                status: RegistrationStatus.PENDING_PAYMENT,
                registrationNumber: regNumber,
                seatHeldUntil,
              },
              include: { schedule: true },
            });
        await tx.examSchedule.update({
          where: { id: scheduleId },
          data: { currentCount: { increment: 1 } },
        });
        return reg;
      });
    } catch (e) {
      // Concurrent double-submit (e.g. the payment page firing create() twice):
      // another request inserted the (userId, scheduleId) seat hold between our
      // findUnique and create. Resolve it gracefully instead of surfacing a raw
      // P2002 — resume the pending hold, or report "Already registered" if the
      // other request already completed payment. The winner owns the
      // currentCount increment, so we never double-count here.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const dup = await this.prisma.registration.findUnique({
          where: { userId_scheduleId: { userId, scheduleId } },
          include: { schedule: true },
        });
        if (dup) {
          if (
            dup.status === RegistrationStatus.PAID ||
            dup.status === RegistrationStatus.EXAM_COMPLETED
          ) {
            throw new ConflictException('Already registered');
          }
          return this.prisma.registration.update({
            where: { id: dup.id },
            data: {
              status: RegistrationStatus.PENDING_PAYMENT,
              cancelledAt: null,
              seatHeldUntil,
            },
            include: { schedule: true },
          });
        }
      }
      throw e;
    }
  }

  async cancel(userId: string, registrationId: string) {
    const reg = await this.prisma.registration.findUnique({
      where: { id: registrationId },
      include: { payments: true },
    });
    if (!reg) throw new NotFoundException('Registration not found');
    if (reg.userId !== userId) throw new ForbiddenException('Not your registration');
    if (
      reg.status === RegistrationStatus.CANCELLED ||
      reg.status === RegistrationStatus.REFUNDED
    ) {
      return { ok: true, alreadyCancelled: true };
    }
    if (reg.status === RegistrationStatus.EXAM_COMPLETED) {
      throw new BadRequestException('Cannot cancel a completed exam');
    }
    const hasConfirmedPayment = reg.payments.some((p) => p.status === 'CONFIRMED');
    if (hasConfirmedPayment) {
      throw new BadRequestException(
        'This registration has been paid. Use the refund endpoint instead.',
      );
    }

    await this.prisma.$transaction([
      this.prisma.registration.update({
        where: { id: registrationId },
        data: { status: RegistrationStatus.CANCELLED, cancelledAt: new Date() },
      }),
      this.prisma.examSchedule.update({
        where: { id: reg.scheduleId },
        data: { currentCount: { decrement: 1 } },
      }),
    ]);
    return { ok: true };
  }

  /** Returns exam voucher data for a paid registration. */
  async getTicket(userId: string, registrationId: string) {
    const reg = await this.prisma.registration.findUnique({
      where: { id: registrationId },
      include: { schedule: true, user: true },
    });
    if (!reg) throw new NotFoundException('Registration not found');
    if (reg.userId !== userId) throw new ForbiddenException('Not your registration');
    if (reg.status !== RegistrationStatus.PAID && reg.status !== RegistrationStatus.EXAM_COMPLETED) {
      throw new BadRequestException('Ticket is only available for paid registrations');
    }
    return {
      regId: reg.id,
      regNo: reg.registrationNumber,
      certType: reg.certType,
      level: reg.level,
      roundNumber: reg.schedule.roundNumber,
      year: reg.schedule.year,
      examDate: reg.schedule.examDate,
      examStartTime: reg.schedule.examStartTime,
      venue: reg.schedule.venue,
      candidateName: reg.user.name,
      seatNumber: reg.seatNumber,
      examDeadline: reg.examDeadline,
      examDeadlineExpired: reg.examDeadline ? new Date() > reg.examDeadline : false,
    };
  }

  /**
   * Cancel a registration with tiered refund logic:
   *   - Before schedule.registrationEnd           → 100% refund
   *   - registrationEnd to 7 days before exam     → 50% refund
   *   - Within 7 days of exam                     → 0% refund (cancel, no money back)
   *
   * If payment is PENDING (not yet confirmed), cancels without refund flow.
   * If payment is CONFIRMED, calls Toss to cancel/partial-cancel.
   */
  async cancelWithRefund(userId: string, registrationId: string, reason = 'User cancellation') {
    const reg = await this.prisma.registration.findUnique({
      where: { id: registrationId },
      include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 }, schedule: true },
    });
    if (!reg) throw new NotFoundException('Registration not found');
    if (reg.userId !== userId) throw new ForbiddenException('Not your registration');
    if (reg.status === RegistrationStatus.CANCELLED || reg.status === RegistrationStatus.REFUNDED) {
      return { ok: true, alreadyCancelled: true };
    }
    if (reg.status === RegistrationStatus.EXAM_COMPLETED) {
      throw new BadRequestException('Cannot cancel a completed exam registration');
    }

    const confirmedPayment = reg.payments.find((p) => p.status === 'CONFIRMED');

    if (!confirmedPayment) {
      // No paid payment — just cancel, decrement seat count
      await this.prisma.$transaction([
        this.prisma.registration.update({
          where: { id: registrationId },
          data: { status: RegistrationStatus.CANCELLED, cancelledAt: new Date() },
        }),
        this.prisma.examSchedule.update({
          where: { id: reg.scheduleId },
          data: { currentCount: { decrement: 1 } },
        }),
      ]);
      return { ok: true, refundAmount: 0, refundTier: 'NO_PAYMENT' };
    }

    // Determine refund tier based on timing
    const now = Date.now();
    const examTime = new Date(reg.schedule.examDate).getTime();
    const regEnd = new Date(reg.schedule.registrationEnd).getTime();
    const sevenDaysMark = examTime - REFUND_HALF_DAYS * 24 * 3600 * 1000;

    let refundAmount: number;
    let refundTier: string;

    if (now < regEnd) {
      refundAmount = confirmedPayment.amount;
      refundTier = 'FULL';
    } else if (now < sevenDaysMark) {
      refundAmount = Math.floor(confirmedPayment.amount / 2);
      refundTier = 'HALF';
    } else {
      refundAmount = 0;
      refundTier = 'NONE';
    }

    if (refundAmount > 0 && confirmedPayment.paymentKey) {
      await this.portoneGateway.cancelPayment(
        confirmedPayment.paymentKey,
        reason,
        refundAmount,
      );
    }

    const newPaymentStatus = refundAmount > 0 ? 'REFUNDED' : 'CANCELLED';
    const newRegStatus =
      refundAmount > 0 ? RegistrationStatus.REFUNDED : RegistrationStatus.CANCELLED;

    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: confirmedPayment.id },
        data: {
          status: newPaymentStatus as never,
          refundAmount,
          refundReason: reason,
          cancelledAt: new Date(),
        },
      }),
      this.prisma.registration.update({
        where: { id: registrationId },
        data: { status: newRegStatus, cancelledAt: new Date() },
      }),
      this.prisma.examSchedule.update({
        where: { id: reg.scheduleId },
        data: { currentCount: { decrement: 1 } },
      }),
    ]);

    return { ok: true, refundAmount, refundTier };
  }

  /**
   * Admin-side refund. Used from the Examinees page when an admin needs to
   * refund a paid-but-not-taken exam on behalf of the user. Supports two
   * modes:
   *
   *   - `TIERED`: mirrors the user-side {@link cancelWithRefund} policy
   *     (100% before reg-end, 50% within 7 days of exam, 0% otherwise).
   *   - `FULL`: 100% refund regardless of timing — used for goodwill /
   *     exceptional cases. SUPER_ADMIN / EXAM_ADMIN only (RBAC enforced at
   *     the controller).
   *
   * Production-safety constraints:
   *   - Hard-rejects when any session for this user+schedule has progressed
   *     beyond CREATED (IN_PROGRESS / SUBMITTED / GRADED / TERMINATED), so an
   *     admin can never refund an exam the candidate actually took.
   *   - Wraps the Toss cancel + DB writes in the same `$transaction` shape as
   *     the user-side path so partial failures roll back together.
   *   - Audit-logs every refund (admin id, mode, reason, registration id,
   *     amount) via the structured AdminAudit logger.
   */
  async adminRefund(
    registrationId: string,
    dto: AdminRefundDto,
    actor: { id: string; name: string },
  ) {
    const reason = dto.reason?.trim();
    if (!reason) throw new BadRequestException('환불 사유는 필수입니다');

    const reg = await this.prisma.registration.findUnique({
      where: { id: registrationId },
      include: {
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
        schedule: true,
        user: { select: { id: true, name: true } },
      },
    });
    if (!reg) throw new NotFoundException('Registration not found');

    if (
      reg.status === RegistrationStatus.REFUNDED ||
      reg.status === RegistrationStatus.CANCELLED
    ) {
      return { ok: true, alreadyCancelled: true, refundAmount: 0 };
    }
    if (reg.status === RegistrationStatus.EXAM_COMPLETED) {
      throw new BadRequestException('이미 시험을 응시한 등록은 환불할 수 없습니다');
    }

    // Block refund if the candidate actually started/finished the exam. The
    // schedule's row alone isn't enough — sessions can be linked by
    // registrationId OR (userId, certType, level) for legacy attempts.
    const blockingSession = await this.prisma.examSession.findFirst({
      where: {
        OR: [
          { registrationId: reg.id },
          { userId: reg.userId, certType: reg.certType, level: reg.level },
        ],
        status: {
          in: [
            ExamSessionStatus.IN_PROGRESS,
            ExamSessionStatus.SUBMITTED,
            ExamSessionStatus.GRADED,
            ExamSessionStatus.TERMINATED,
          ],
        },
      },
      select: { id: true, status: true },
    });
    if (blockingSession) {
      throw new ConflictException(
        `시험이 이미 ${blockingSession.status} 상태입니다. 응시한 시험은 환불할 수 없습니다.`,
      );
    }

    const confirmedPayment = reg.payments.find((p) => p.status === 'CONFIRMED');

    if (!confirmedPayment) {
      // No confirmed payment to refund — just cancel the registration and free the seat.
      await this.prisma.$transaction([
        this.prisma.registration.update({
          where: { id: reg.id },
          data: { status: RegistrationStatus.CANCELLED, cancelledAt: new Date() },
        }),
        this.prisma.examSchedule.update({
          where: { id: reg.scheduleId },
          data: { currentCount: { decrement: 1 } },
        }),
      ]);
      this.writeAdminRefundAudit({
        actor,
        registrationId: reg.id,
        targetUserName: reg.user.name,
        mode: dto.mode,
        amount: 0,
        reason,
        outcome: 'NO_PAYMENT',
      });
      return { ok: true, refundAmount: 0, refundTier: 'NO_PAYMENT' };
    }

    let refundAmount: number;
    let refundTier: string;
    if (dto.mode === 'FULL') {
      refundAmount = confirmedPayment.amount;
      refundTier = 'ADMIN_FULL';
    } else {
      // Tiered policy — same arithmetic as the user-side cancelWithRefund.
      const now = Date.now();
      const examTime = new Date(reg.schedule.examDate).getTime();
      const regEnd = new Date(reg.schedule.registrationEnd).getTime();
      const sevenDaysMark = examTime - REFUND_HALF_DAYS * 24 * 3600 * 1000;
      if (now < regEnd) {
        refundAmount = confirmedPayment.amount;
        refundTier = 'FULL';
      } else if (now < sevenDaysMark) {
        refundAmount = Math.floor(confirmedPayment.amount / 2);
        refundTier = 'HALF';
      } else {
        refundAmount = 0;
        refundTier = 'NONE';
      }
    }

    if (refundAmount > 0 && confirmedPayment.paymentKey) {
      await this.portoneGateway.cancelPayment(
        confirmedPayment.paymentKey,
        `[ADMIN:${actor.id}] ${reason}`,
        refundAmount,
      );
    }

    const newPaymentStatus = refundAmount > 0 ? 'REFUNDED' : 'CANCELLED';
    const newRegStatus =
      refundAmount > 0 ? RegistrationStatus.REFUNDED : RegistrationStatus.CANCELLED;

    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: confirmedPayment.id },
        data: {
          status: newPaymentStatus as never,
          refundAmount,
          refundReason: `[ADMIN:${actor.id}] ${reason}`,
          cancelledAt: new Date(),
        },
      }),
      this.prisma.registration.update({
        where: { id: reg.id },
        data: { status: newRegStatus, cancelledAt: new Date() },
      }),
      this.prisma.examSchedule.update({
        where: { id: reg.scheduleId },
        data: { currentCount: { decrement: 1 } },
      }),
    ]);

    this.writeAdminRefundAudit({
      actor,
      registrationId: reg.id,
      targetUserName: reg.user.name,
      mode: dto.mode,
      amount: refundAmount,
      reason,
      outcome: refundTier,
    });

    return { ok: true, refundAmount, refundTier };
  }

  private writeAdminRefundAudit(params: {
    actor: { id: string; name: string };
    registrationId: string;
    targetUserName: string;
    mode: 'TIERED' | 'FULL';
    amount: number;
    reason: string;
    outcome: string;
  }): void {
    try {
      this.auditLogger.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          action: 'REGISTRATION_REFUND_ADMIN',
          actorId: params.actor.id,
          actorName: params.actor.name,
          registrationId: params.registrationId,
          targetUserName: params.targetUserName,
          mode: params.mode,
          amount: params.amount,
          reason: params.reason,
          outcome: params.outcome,
        }),
      );
    } catch {
      /* swallow */
    }
  }

  /**
   * Quick book: Create an on-demand schedule + registration in one step.
   * For online exams that can start any time.
   * 
   * If examDate is not provided, creates a schedule for immediate start.
   */
  async quickBook(userId: string, dto: QuickBookDto) {
    await this.releaseExpiredSeatHolds();
    // Create or find an on-demand schedule
    const examDate = dto.examDate ?? new Date().toISOString();
    
    const schedule = await this.schedules.createOnDemand({
      certType: dto.certType,
      level: dto.level,
      examDate,
      venue: 'ONLINE_CBT',
    });

    // Create registration for this schedule
    const seatHeldUntil = new Date(Date.now() + SEAT_HOLD_MINUTES * 60_000);

    const reg = await this.prisma.$transaction(async (tx) => {
      const regSequence = (await tx.registration.count({
        where: { scheduleId: schedule.id },
      })) + 1;
      const regNumber = this.generateRegistrationNumber(
        schedule.certType,
        schedule.year,
        schedule.level,
        schedule.roundNumber,
        regSequence,
      );
      const created = await tx.registration.create({
        data: {
          userId,
          scheduleId: schedule.id,
          certType: schedule.certType,
          level: schedule.level,
          status: RegistrationStatus.PENDING_PAYMENT,
          registrationNumber: regNumber,
          seatHeldUntil,
        },
        include: { schedule: true },
      });

      await tx.examSchedule.update({
        where: { id: schedule.id },
        data: { currentCount: { increment: 1 } },
      });
      return created;
    });

    // Get the fee for this certification level
    const certLevel = await this.prisma.certificationLevel.findFirst({
      where: { 
        level: dto.level,
        certification: { type: dto.certType },
      },
    });

    return {
      registration: reg,
      schedule,
      fee: certLevel?.fee ?? 0,
      message: 'Registration created. Complete payment to start exam.',
    };
  }

  async grantAttempt(
    registrationId: string,
    actor: { id: string; name: string },
    reason?: string,
  ): Promise<{
    ok: true;
    attemptsUsed: number;
    maxAttempts: number;
    attemptsLeft: number;
    bonusGranted: number;
  }> {
    const reg = await this.prisma.registration.findUnique({
      where: { id: registrationId },
      include: {
        user: { select: { id: true, name: true } },
      },
    });
    if (!reg) throw new NotFoundException('Registration not found');

    if (
      reg.status === RegistrationStatus.CANCELLED ||
      reg.status === RegistrationStatus.REFUNDED
    ) {
      throw new BadRequestException('취소·환불된 등록에는 응시 기회를 부여할 수 없습니다');
    }

    const sessions = await this.prisma.examSession.findMany({
      where: { registrationId },
      select: { id: true, status: true, attemptNo: true, passed: true },
    });

    if (sessions.some((s) => s.passed === true)) {
      throw new BadRequestException('합격한 등록에는 추가 응시를 부여할 수 없습니다');
    }
    if (sessions.some((s) => s.status === ExamSessionStatus.IN_PROGRESS)) {
      throw new BadRequestException('시험 진행 중에는 추가 응시를 부여할 수 없습니다');
    }

    const currentBonus = await getBonusAttempts(this.redis, registrationId);
    if (currentBonus >= MAX_BONUS_ATTEMPTS) {
      throw new BadRequestException(
        `이 등록에 허용된 최대 추가 응시(${MAX_BONUS_ATTEMPTS}회)를 모두 부여했습니다`,
      );
    }

    const newBonus = await this.redis.incr(BONUS_ATTEMPTS_KEY(registrationId));
    if (newBonus === null) {
      throw new BadRequestException('응시 기회 부여에 실패했습니다. 잠시 후 다시 시도해 주세요');
    }
    if (newBonus > MAX_BONUS_ATTEMPTS) {
      await this.redis.set(BONUS_ATTEMPTS_KEY(registrationId), String(MAX_BONUS_ATTEMPTS));
      throw new BadRequestException(
        `이 등록에 허용된 최대 추가 응시(${MAX_BONUS_ATTEMPTS}회)를 모두 부여했습니다`,
      );
    }

    if (reg.status === RegistrationStatus.EXAM_COMPLETED) {
      await this.prisma.registration.update({
        where: { id: registrationId },
        data: { status: RegistrationStatus.PAID },
      });
    }

    const maxAttempts = MAX_ATTEMPTS + newBonus;
    const attemptsUsed = sessions.reduce((max, s) => Math.max(max, s.attemptNo), 0);
    const attemptsLeft = Math.max(0, maxAttempts - attemptsUsed);

    this.auditLogger.log(
      JSON.stringify({
        action: 'REGISTRATION_GRANT_ATTEMPT',
        actorId: actor.id,
        actorName: actor.name,
        targetRegistrationId: registrationId,
        targetUserName: reg.user.name,
        reason: reason?.trim() || null,
        bonusAttempts: newBonus,
        maxAttempts,
        attemptsLeft,
      }),
    );

    return {
      ok: true,
      attemptsUsed,
      maxAttempts,
      attemptsLeft,
      bonusGranted: newBonus,
    };
  }

  private generateRegistrationNumber(
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
}

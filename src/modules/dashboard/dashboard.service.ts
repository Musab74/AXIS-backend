import { Injectable } from '@nestjs/common';
import { ExamSessionStatus, RegistrationStatus, ScheduleStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../integrations/redis/redis.service';
import { RegistrationsService } from '../registrations/registrations.service';
import { ResultsService } from '../results/results.service';
import { UsersService } from '../users/users.service';
import { CertificatesService } from '../certificates/certificates.service';
import { MAX_ATTEMPTS } from '../cbtSessions/exam-spec';
import { getBonusAttempts } from '../cbtSessions/registration-bonus-attempts';

const ONE_YEAR_MS = 365 * 24 * 3600 * 1000;

const TERMINAL_STATUSES: ExamSessionStatus[] = [
  ExamSessionStatus.SUBMITTED,
  ExamSessionStatus.GRADED,
  ExamSessionStatus.TERMINATED,
];

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly registrations: RegistrationsService,
    private readonly results: ResultsService,
    private readonly certificates: CertificatesService,
    private readonly redis: RedisService,
  ) {}

  async getMyDashboard(userId: string) {
    const [profile, regs, results, upcomingSchedules, certificates, sessions] = await Promise.all([
      this.users.getProfile(userId),
      this.registrations.listMine(userId),
      this.results.listMine(userId),
      this.prisma.examSchedule.findMany({
        where: {
          status: { in: [ScheduleStatus.UPCOMING, ScheduleStatus.REGISTRATION_OPEN] },
          examDate: { gte: new Date() },
        },
        orderBy: { examDate: 'asc' },
        take: 20,
      }),
      this.certificates.syncPassedCertificatesForUser(userId),
      this.prisma.examSession.findMany({
        where: { userId },
        select: { registrationId: true, status: true, attemptNo: true },
      }),
    ]);

    // Build per-registration attempt stats (read-only aggregation)
    const attemptsByReg = new Map<string, { used: number; maxAttempts: number; exhausted: boolean }>();
    for (const s of sessions) {
      if (!s.registrationId) continue;
      const entry = attemptsByReg.get(s.registrationId) ?? { used: 0, maxAttempts: MAX_ATTEMPTS, exhausted: false };
      if (TERMINAL_STATUSES.includes(s.status)) {
        entry.used = Math.max(entry.used, s.attemptNo);
      }
      attemptsByReg.set(s.registrationId, entry);
    }
    for (const [, entry] of attemptsByReg) {
      entry.exhausted = entry.used >= entry.maxAttempts;
    }
    for (const r of regs) {
      const bonus = await getBonusAttempts(this.redis, r.id);
      const entry = attemptsByReg.get(r.id) ?? { used: 0, maxAttempts: MAX_ATTEMPTS + bonus, exhausted: false };
      entry.maxAttempts = MAX_ATTEMPTS + bonus;
      entry.exhausted = entry.used >= entry.maxAttempts;
      attemptsByReg.set(r.id, entry);
    }

    // Stats for "Registrations" section
    const regStats = {
      total: regs.length,
      awaitingPayment: regs.filter((r) => r.status === RegistrationStatus.PENDING_PAYMENT).length,
      confirmed: regs.filter((r) => r.status === RegistrationStatus.PAID).length,
      cancelled: regs.filter(
        (r) =>
          r.status === RegistrationStatus.CANCELLED || r.status === RegistrationStatus.REFUNDED,
      ).length,
    };

    // Stats for "Taken" section
    const takenStats = {
      total: results.length,
      passed: results.filter((r) => r.passed === true).length,
      partial: results.filter((r) => r.partialPass != null).length,
      failed: results.filter((r) => r.passed === false && r.partialPass == null).length,
    };

    // Partial-pass exemptions still active (12 months)
    const now = Date.now();
    const partials = results
      .filter((r) => r.partialPass != null && r.submittedAt != null)
      .map((r) => {
        const expiresAt = new Date(new Date(r.submittedAt!).getTime() + ONE_YEAR_MS);
        const active = expiresAt.getTime() > now;
        return {
          sessionId: r.id,
          certType: r.certType,
          level: r.level,
          partType: r.partialPass,
          writtenScore: r.writtenScore,
          practicalScore: r.practicalScore,
          submittedAt: r.submittedAt,
          expiresAt,
          active,
        };
      });

    return {
      profile,
      registrations: regs.map((r) => {
        const attempts = attemptsByReg.get(r.id);
        return {
          ...r,
          attemptUsed: attempts?.used ?? 0,
          maxAttempts: attempts?.maxAttempts ?? MAX_ATTEMPTS,
          attemptsExhausted: attempts?.exhausted ?? false,
        };
      }),
      registrationStats: regStats,
      results,
      takenStats,
      partialExemptions: partials,
      certificates: certificates.map((c) => ({
        sessionId: c.sessionId,
        certNumber: c.certNumber,
        certType: c.certType,
        level: c.level,
        issuedAt: c.issuedAt,
        validUntil: c.validUntil,
        totalScore: c.totalScore,
        holderName: c.holderName,
        holderBirthDate: c.holderBirthDate,
      })),
      upcomingSchedules: upcomingSchedules.map((s) => ({
        id: s.id,
        certType: s.certType,
        level: s.level,
        roundNumber: s.roundNumber,
        year: s.year,
        registrationStart: s.registrationStart,
        registrationEnd: s.registrationEnd,
        examDate: s.examDate,
        examStartTime: s.examStartTime,
        capacity: s.capacity,
        currentCount: s.currentCount,
        status: s.status,
      })),
    };
  }
}

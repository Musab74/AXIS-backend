import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CertType,
  ExamSessionStatus,
  Prisma,
  RegistrationStatus,
  ScheduleStatus,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { CertificatesService } from '../certificates/certificates.service';

@Injectable()
export class ResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly certificates: CertificatesService,
  ) {}

  /**
   * All exam sessions for a user that are submitted or graded.
   * Includes the breakdown by subject and a derived "partial pass" flag for L2/L1.
   */
  async listMine(userId: string) {
    const certificates = await this.certificates.syncPassedCertificatesForUser(userId);
    const certBySessionId = new Map(certificates.map((c) => [c.sessionId, c]));

    const sessions = await this.prisma.examSession.findMany({
      where: {
        userId,
        status: { in: [ExamSessionStatus.SUBMITTED, ExamSessionStatus.GRADED] },
      },
      include: {
        gradingResults: { orderBy: [{ part: 'asc' }, { subjectIndex: 'asc' }] },
      },
      orderBy: { submittedAt: 'desc' },
    });

    const registrationIds = [
      ...new Set(
        sessions.map((s) => s.registrationId).filter((id): id is string => !!id),
      ),
    ];
    const registrations =
      registrationIds.length > 0
        ? await this.prisma.registration.findMany({
            where: { id: { in: registrationIds } },
            include: { schedule: true },
          })
        : [];
    const regById = new Map(registrations.map((r) => [r.id, r]));

    return sessions.map((s) => {
      const cert = certBySessionId.get(s.id);
      const reg = s.registrationId ? regById.get(s.registrationId) : undefined;
      const graded = s.status === ExamSessionStatus.GRADED;
      return {
        id: s.id,
        certType: s.certType,
        level: s.level,
        attemptNo: s.attemptNo,
        status: s.status,
        registrationId: s.registrationId,
        registrationNumber: reg?.registrationNumber ?? null,
        roundNumber: reg?.schedule.roundNumber ?? null,
        scheduleYear: reg?.schedule.year ?? null,
        submittedAt: s.submittedAt,
        startedAt: s.startedAt,
        gradedAt: graded ? s.updatedAt : null,
        writtenScore: s.writtenScore,
        practicalScore: s.practicalScore,
        totalScore: s.totalScore,
        passed: s.passed,
        failReason: s.failReason,
        partialPass: this.derivePartial(s),
        certificate: cert
          ? {
              certNumber: cert.certNumber,
              issuedAt: cert.issuedAt,
              validUntil: cert.validUntil,
            }
          : null,
        breakdown: s.gradingResults.map((r) => ({
        part: r.part,
        subjectIndex: r.subjectIndex,
        subjectName: r.subjectName,
        earned: r.earned,
        total: r.total,
        percentage: r.percentage,
        subjectFailed: r.subjectFailed,
        })),
      };
    });
  }

  private derivePartial(s: {
    level: 'L3' | 'L2' | 'L1';
    writtenScore: number | null;
    practicalScore: number | null;
    passed: boolean | null;
  }) {
    if (s.level === 'L3') return null;
    if (s.passed) return null;
    const writtenPassed = (s.writtenScore ?? 0) >= 60;
    const practicalPassed = (s.practicalScore ?? 0) >= 60;
    if (writtenPassed && !practicalPassed) return 'WRITTEN_ONLY';
    if (!writtenPassed && practicalPassed) return 'PRACTICAL_ONLY';
    return null;
  }

  /**
   * Public summary rows for axisexam.com/results — driven by ExamSchedule + graded ExamSession rows.
   * Admins control visibility by setting schedule status (COMPLETED = 발표 완료).
   */
  async listPublicRounds(params: { certType?: CertType; page: number; pageSize: number }) {
    const where = {
      status: { not: ScheduleStatus.CANCELLED },
      ...(params.certType ? { certType: params.certType } : {}),
    };
    const page = Math.max(1, params.page);
    const pageSize = Math.min(50, Math.max(5, params.pageSize));
    const skip = (page - 1) * pageSize;

    const [total, schedules] = await Promise.all([
      this.prisma.examSchedule.count({ where }),
      this.prisma.examSchedule.findMany({
        where,
        orderBy: [{ examDate: 'desc' }, { certType: 'asc' }, { level: 'asc' }, { roundNumber: 'desc' }],
        skip,
        take: pageSize,
      }),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

    if (schedules.length === 0) {
      return { items: [], total, page, pageSize, totalPages };
    }

    const scheduleIds = schedules.map((s) => s.id);
    const [gradedBySchedule, registeredBySchedule] = await Promise.all([
      this.aggregatePassFailBySchedule(scheduleIds),
      this.countConfirmedRegistrationsBySchedule(scheduleIds),
    ]);
    const now = Date.now();

    const items = schedules.map((s) => {
      const g = gradedBySchedule.get(s.id);
      const passCount = g?.passCount ?? 0;
      const failCount = g?.failCount ?? 0;
      const registeredCount = registeredBySchedule.get(s.id) ?? 0;
      const examMs = s.examDate.getTime();
      const publicationState = this.resolvePublicationState(s.status, examMs, now);
      return {
        scheduleId: s.id,
        certType: s.certType,
        level: s.level,
        roundNumber: s.roundNumber,
        year: s.year,
        examDate: s.examDate.toISOString(),
        scheduleStatus: s.status,
        publicationState,
        /** 결제·확정 접수 기준 (PAID + EXAM_COMPLETED) */
        registeredCount,
        /** 발표 완료 회차만 채워짐 */
        passCount: publicationState === 'announced' ? passCount : null,
        failCount: publicationState === 'announced' ? failCount : null,
        labelRound: this.formatRoundLabel(s.certType, s.level, s.roundNumber),
      };
    });

    return { items, total, page, pageSize, totalPages };
  }

  async getPublicPassList(scheduleId: string) {
    const schedule = await this.prisma.examSchedule.findUnique({ where: { id: scheduleId } });
    if (!schedule || schedule.status === ScheduleStatus.CANCELLED) {
      throw new NotFoundException('Schedule not found');
    }
    if (schedule.status !== ScheduleStatus.COMPLETED) {
      throw new NotFoundException('Results are not published for this round yet');
    }

    const regs = await this.prisma.registration.findMany({
      where: {
        scheduleId,
        status: { in: [RegistrationStatus.PAID, RegistrationStatus.EXAM_COMPLETED] },
      },
      select: { id: true, registrationNumber: true },
    });
    const regIds = regs.map((r) => r.id);
    const regNoById = new Map(regs.map((r) => [r.id, r.registrationNumber]));

    if (regIds.length === 0) {
      return {
        schedule: {
          id: schedule.id,
          certType: schedule.certType,
          level: schedule.level,
          roundNumber: schedule.roundNumber,
          year: schedule.year,
          examDate: schedule.examDate.toISOString(),
          status: schedule.status,
          labelRound: this.formatRoundLabel(schedule.certType, schedule.level, schedule.roundNumber),
        },
        summary: { registeredCount: 0, passCount: 0, failCount: 0, gradedCount: 0 },
        entries: [] as { registrationNumberMasked: string; passed: boolean }[],
      };
    }

    const graded = await this.prisma.examSession.findMany({
      where: {
        status: ExamSessionStatus.GRADED,
        registrationId: { in: regIds },
      },
      select: {
        registrationId: true,
        passed: true,
        attemptNo: true,
      },
    });

    const latest = this.latestGradedPerRegistration(
      graded.map((row) => ({
        registrationId: row.registrationId,
        passed: row.passed,
        attemptNo: row.attemptNo,
        registration: {
          registrationNumber: row.registrationId ? regNoById.get(row.registrationId) ?? null : null,
        },
      })),
    );
    const entries = [...latest.values()].map((row) => ({
      registrationNumberMasked: this.maskRegistrationNumber(row.registrationNumber),
      passed: row.passed,
    }));

    const passCount = entries.filter((e) => e.passed).length;
    const failCount = entries.length - passCount;
    const registeredCount = regs.length;
    const gradedCount = entries.length;

    return {
      schedule: {
        id: schedule.id,
        certType: schedule.certType,
        level: schedule.level,
        roundNumber: schedule.roundNumber,
        year: schedule.year,
        examDate: schedule.examDate.toISOString(),
        status: schedule.status,
        labelRound: this.formatRoundLabel(schedule.certType, schedule.level, schedule.roundNumber),
      },
      summary: { registeredCount, passCount, failCount, gradedCount },
      entries,
    };
  }

  /**
   * Public (no-login) score lookup by registration number + name + birth date.
   *
   * Every failure mode that involves an identity mismatch returns the same
   * NOT_FOUND so the endpoint can't be used to probe which registration
   * numbers exist or whose they are. NOT_ANNOUNCED is only revealed after
   * the caller has proven all three identity facts.
   */
  async publicLookup(input: { registrationNumber: string; name: string; birthDate: string }) {
    const NOT_FOUND = { status: 'NOT_FOUND' as const };

    const regNo = input.registrationNumber.trim();
    if (!regNo) return NOT_FOUND;

    const reg = await this.prisma.registration.findUnique({
      where: { registrationNumber: regNo },
      include: {
        user: { select: { name: true, birthDate: true } },
        schedule: true,
      },
    });
    if (!reg) return NOT_FOUND;
    if (
      reg.status !== RegistrationStatus.PAID &&
      reg.status !== RegistrationStatus.EXAM_COMPLETED
    ) {
      return NOT_FOUND;
    }
    if (!this.namesMatch(reg.user.name, input.name)) return NOT_FOUND;
    // No birth date on file → the second factor can't be verified, so the
    // public lookup refuses; the user can still see results via My Page.
    if (!this.birthDatesMatch(reg.user.birthDate, input.birthDate)) return NOT_FOUND;

    if (reg.schedule.status !== ScheduleStatus.COMPLETED) {
      return { status: 'NOT_ANNOUNCED' as const };
    }

    const session = await this.prisma.examSession.findFirst({
      where: { registrationId: reg.id, status: ExamSessionStatus.GRADED },
      orderBy: { attemptNo: 'desc' },
      include: {
        gradingResults: { orderBy: [{ part: 'asc' }, { subjectIndex: 'asc' }] },
      },
    });
    // Round announced but this candidate's grading isn't finalized yet.
    if (!session) return { status: 'NOT_ANNOUNCED' as const };

    return {
      status: 'RESULT' as const,
      passed: session.passed === true,
      totalScore: session.totalScore,
      cutScore: 70,
      certType: reg.certType,
      level: reg.level,
      roundLabel: this.formatRoundLabel(
        reg.schedule.certType,
        reg.schedule.level,
        reg.schedule.roundNumber,
      ),
      examDate: reg.schedule.examDate.toISOString(),
      sections: session.gradingResults.map((r) => ({
        name: r.subjectName,
        score: r.earned,
        max: r.total,
      })),
    };
  }

  private namesMatch(stored: string, given: string): boolean {
    const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
    const g = norm(given);
    return g.length > 0 && norm(stored) === g;
  }

  private birthDatesMatch(stored: string | null, given: string): boolean {
    if (!stored) return false;
    const digits = (s: string) => s.replace(/\D/g, '');
    const g = digits(given);
    return g.length === 8 && digits(stored) === g;
  }

  private resolvePublicationState(
    status: ScheduleStatus,
    examStartMs: number,
    nowMs: number,
  ): 'announced' | 'grading' | 'upcoming' {
    if (status === ScheduleStatus.COMPLETED) return 'announced';
    if (status === ScheduleStatus.CANCELLED) return 'upcoming';
    if (examStartMs <= nowMs) return 'grading';
    return 'upcoming';
  }

  private formatRoundLabel(certType: CertType, level: string, roundNumber: number): string {
    const track = certType === CertType.AXIS_C ? 'AXIS-C' : certType === CertType.AXIS_H ? 'AXIS-H' : 'AXIS';
    return `제${roundNumber}회 ${track} ${level}`;
  }

  private async countConfirmedRegistrationsBySchedule(
    scheduleIds: string[],
  ): Promise<Map<string, number>> {
    if (scheduleIds.length === 0) return new Map();
    const rows = await this.prisma.registration.groupBy({
      by: ['scheduleId'],
      where: {
        scheduleId: { in: scheduleIds },
        status: { in: [RegistrationStatus.PAID, RegistrationStatus.EXAM_COMPLETED] },
      },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.scheduleId, r._count._all]));
  }

  /** Latest GRADED attempt per registration → pass / fail counts per schedule (MySQL 8). */
  private async aggregatePassFailBySchedule(
    scheduleIds: string[],
  ): Promise<Map<string, { passCount: number; failCount: number }>> {
    if (scheduleIds.length === 0) return new Map();

    const rows = await this.prisma.$queryRaw<
      Array<{ scheduleId: string; passCount: bigint; failCount: bigint }>
    >(
      Prisma.sql`
        WITH latest AS (
          SELECT
            es.registration_id AS rid,
            es.passed AS passed,
            r.schedule_id AS sid,
            ROW_NUMBER() OVER (PARTITION BY es.registration_id ORDER BY es.attempt_no DESC) AS rn
          FROM exam_sessions es
          INNER JOIN registrations r ON r.id = es.registration_id
          WHERE es.status = 'GRADED'
            AND r.schedule_id IN (${Prisma.join(scheduleIds)})
            AND r.status IN ('PAID', 'EXAM_COMPLETED')
        )
        SELECT
          sid AS scheduleId,
          CAST(COALESCE(SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END), 0) AS UNSIGNED) AS passCount,
          CAST(
            COUNT(*) - COALESCE(SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END), 0)
            AS UNSIGNED
          ) AS failCount
        FROM latest
        WHERE rn = 1
        GROUP BY sid
      `,
    );

    const out = new Map<string, { passCount: number; failCount: number }>();
    for (const r of rows) {
      out.set(r.scheduleId, {
        passCount: Number(r.passCount),
        failCount: Number(r.failCount),
      });
    }
    return out;
  }

  private latestGradedPerRegistration(
    rows: Array<{
      registrationId: string | null;
      passed: boolean | null;
      attemptNo: number;
      registration: { registrationNumber: string | null };
    }>,
  ): Map<string, { passed: boolean; registrationNumber: string | null }> {
    const m = new Map<string, { passed: boolean; attemptNo: number; registrationNumber: string | null }>();
    for (const row of rows) {
      if (!row.registrationId) continue;
      const prev = m.get(row.registrationId);
      if (!prev || row.attemptNo > prev.attemptNo) {
        m.set(row.registrationId, {
          passed: row.passed === true,
          attemptNo: row.attemptNo,
          registrationNumber: row.registration.registrationNumber,
        });
      }
    }
    const out = new Map<string, { passed: boolean; registrationNumber: string | null }>();
    for (const [id, v] of m) {
      out.set(id, { passed: v.passed, registrationNumber: v.registrationNumber });
    }
    return out;
  }

  private maskRegistrationNumber(regNo: string | null): string {
    if (!regNo) return '—';
    const t = regNo.trim();
    if (t.length <= 4) return '****';
    return `****${t.slice(-4)}`;
  }
}

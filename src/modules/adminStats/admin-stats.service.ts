import { Injectable } from '@nestjs/common';
import {
  CertLevel,
  CertType,
  ExamPart,
  ExamSessionStatus,
  Prisma,
  ProctorEventType,
  ScheduleStatus,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { StatsFilterDto } from './dto/stats-query.dto';

const MS_PER_DAY = 24 * 3600 * 1000;
const ALERT_LIMIT = 20;
const UPCOMING_LIMIT = 5;
const TREND_ROUNDS = 10;

type SessionFilter = Prisma.ExamSessionWhereInput;

@Injectable()
export class AdminStatsService {
  constructor(private readonly prisma: PrismaService) {}

  // ──────────────────────────────────────────────────────────
  // GET /admin/stats/dashboard
  // ──────────────────────────────────────────────────────────
  async dashboard() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      cumulativeUsers,
      gradedSessions,
      passedSessions,
      monthlyRegistrations,
      sessionStatusGroups,
      upcomingSchedules,
      recentEvents,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.examSession.count({ where: { status: ExamSessionStatus.GRADED } }),
      this.prisma.examSession.count({ where: { status: ExamSessionStatus.GRADED, passed: true } }),
      this.prisma.registration.count({ where: { createdAt: { gte: monthStart } } }),
      this.prisma.examSession.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.examSchedule.findMany({
        where: {
          status: { in: [ScheduleStatus.UPCOMING, ScheduleStatus.REGISTRATION_OPEN] },
          examDate: { gte: now },
        },
        orderBy: { examDate: 'asc' },
        take: UPCOMING_LIMIT,
      }),
      this.prisma.proctoringEvent.findMany({
        where: {
          eventType: {
            in: [
              ProctorEventType.AI_FLAG_SUSPICIOUS,
              ProctorEventType.AI_FLAG_CONFIRMED,
              ProctorEventType.MULTIPLE_FACES,
              ProctorEventType.FACE_NOT_DETECTED,
              ProctorEventType.PHONE_DETECTED,
              ProctorEventType.FULLSCREEN_EXIT,
            ],
          },
        },
        orderBy: { createdAt: 'desc' },
        take: ALERT_LIMIT,
      }),
    ]);

    const passRate =
      gradedSessions > 0 ? Math.round((passedSessions / gradedSessions) * 1000) / 10 : 0;

    const statusCount = (s: ExamSessionStatus) =>
      sessionStatusGroups.find((g) => g.status === s)?._count._all ?? 0;
    const completed = statusCount(ExamSessionStatus.GRADED);
    const submitted = statusCount(ExamSessionStatus.SUBMITTED);
    const inProgress = statusCount(ExamSessionStatus.IN_PROGRESS);
    const created = statusCount(ExamSessionStatus.CREATED);
    const totalForGrading = completed + submitted + inProgress + created;
    const gradingProgress =
      totalForGrading > 0 ? Math.round((completed / totalForGrading) * 100) : 0;

    return {
      cumulativeUsers,
      passRate,
      monthlyRegistrations,
      gradingProgress,
      gradingDonut: {
        completed,
        reviewing: submitted,
        waiting: inProgress + created,
      },
      alerts: recentEvents.map((e) => ({
        id: e.id,
        level: e.severity ?? this.eventLevel(e.eventType),
        message: e.captionEn ?? e.captionKo ?? this.eventLabel(e.eventType),
        createdAt: e.createdAt,
      })),
      upcomingExams: upcomingSchedules.map((s) => ({
        scheduleId: s.id,
        name: `${this.certLabel(s.certType)} ${s.level} · Round ${s.roundNumber}`,
        dDay: Math.ceil((s.examDate.getTime() - now.getTime()) / MS_PER_DAY),
        date: s.examDate,
      })),
    };
  }

  // ──────────────────────────────────────────────────────────
  // GET /admin/stats/pass-rate
  // ──────────────────────────────────────────────────────────
  async passRate(filter: StatsFilterDto) {
    const where = this.buildSessionFilter(filter);

    const [graded, allSessions, byCertGroups] = await Promise.all([
      this.prisma.examSession.findMany({
        where: { ...where, status: ExamSessionStatus.GRADED },
        select: {
          level: true,
          passed: true,
          submittedAt: true,
          certType: true,
          registrationId: true,
        },
      }),
      this.prisma.examSession.findMany({
        where,
        select: { status: true, passed: true, writtenScore: true, practicalScore: true, level: true },
      }),
      this.groupByCert(filter),
    ]);

    const trend = this.computeRoundTrend(graded);
    const distribution = this.computeDistribution(allSessions);

    return { trend, distribution, byCert: byCertGroups };
  }

  // ──────────────────────────────────────────────────────────
  // GET /admin/stats/subjects
  // ──────────────────────────────────────────────────────────
  async subjects(filter: StatsFilterDto) {
    const where = this.buildSessionFilter(filter);
    const sessionIds = (
      await this.prisma.examSession.findMany({ where, select: { id: true } })
    ).map((s) => s.id);

    const [results, essayAnswers] = await Promise.all([
      sessionIds.length
        ? this.prisma.gradingResult.findMany({
            where: { sessionId: { in: sessionIds } },
            select: { sessionId: true, part: true, subjectName: true, percentage: true },
          })
        : Promise.resolve([] as { sessionId: string; part: ExamPart; subjectName: string; percentage: number }[]),
      sessionIds.length
        ? this.prisma.essayAnswer.findMany({
            where: { sessionId: { in: sessionIds } },
            select: {
              taskId: true,
              aiPreScore: true,
              expertScore: true,
              earnedPoints: true,
            },
          })
        : Promise.resolve([] as { taskId: string; aiPreScore: number | null; expertScore: number | null; earnedPoints: number | null }[]),
    ]);

    const writtenResults = results.filter((r) => r.part === ExamPart.WRITTEN);
    const averages = this.aggregateAverages(writtenResults);

    const heatmap = this.buildHeatmap(graded =>
      writtenResults.map((r) => ({ subject: r.subjectName, sessionId: r.sessionId, value: r.percentage })),
      sessionIds,
    );

    const taskIds = [...new Set(essayAnswers.map((e) => e.taskId))];
    const taskTemplates = taskIds.length
      ? await this.prisma.taskTemplate.findMany({
          where: { id: { in: taskIds } },
          select: { id: true, title: true, points: true, level: true, part: true },
        })
      : [];
    const taskById = new Map(taskTemplates.map((t) => [t.id, t]));
    const practical = this.aggregatePractical(essayAnswers, taskById);

    const aiVsExpert = essayAnswers
      .filter((e) => e.aiPreScore != null && e.expertScore != null)
      .map((e) => ({ aiScore: e.aiPreScore as number, expertScore: e.expertScore as number }));

    return { averages, heatmap, practical, aiVsExpert };
  }

  // ──────────────────────────────────────────────────────────
  // helpers
  // ──────────────────────────────────────────────────────────

  private buildSessionFilter(f: StatsFilterDto): SessionFilter {
    const where: SessionFilter = {};
    if (f.certType) where.certType = f.certType;
    if (f.level) where.level = f.level;
    if (f.from || f.to) {
      where.submittedAt = {};
      if (f.from) (where.submittedAt as Prisma.DateTimeFilter).gte = new Date(f.from);
      if (f.to) (where.submittedAt as Prisma.DateTimeFilter).lte = new Date(f.to);
    }
    return where;
  }

  private computeRoundTrend(
    sessions: { level: CertLevel; passed: boolean | null; submittedAt: Date | null }[],
  ) {
    const buckets = new Map<
      string,
      { L1: { p: number; t: number }; L2: { p: number; t: number }; L3: { p: number; t: number } }
    >();
    for (const s of sessions) {
      if (!s.submittedAt) continue;
      const round = `${s.submittedAt.getFullYear()}-${String(
        Math.ceil((s.submittedAt.getMonth() + 1) / 1),
      ).padStart(2, '0')}`;
      const b =
        buckets.get(round) ??
        { L1: { p: 0, t: 0 }, L2: { p: 0, t: 0 }, L3: { p: 0, t: 0 } };
      const lvl = b[s.level];
      lvl.t += 1;
      if (s.passed === true) lvl.p += 1;
      buckets.set(round, b);
    }
    return Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-TREND_ROUNDS)
      .map(([round, b]) => ({
        round,
        l3: b.L3.t > 0 ? Math.round((b.L3.p / b.L3.t) * 1000) / 10 : 0,
        l2: b.L2.t > 0 ? Math.round((b.L2.p / b.L2.t) * 1000) / 10 : 0,
        l1: b.L1.t > 0 ? Math.round((b.L1.p / b.L1.t) * 1000) / 10 : 0,
      }));
  }

  private computeDistribution(
    sessions: { status: ExamSessionStatus; passed: boolean | null; writtenScore: number | null; practicalScore: number | null; level: CertLevel }[],
  ) {
    let pass = 0;
    let fail = 0;
    let partial = 0;
    let inProgress = 0;
    for (const s of sessions) {
      if (s.status !== ExamSessionStatus.GRADED) {
        inProgress += 1;
        continue;
      }
      if (s.passed) {
        pass += 1;
        continue;
      }
      const w = s.writtenScore ?? 0;
      const p = s.practicalScore;
      const writtenPass = w >= 60;
      const practicalPass = p != null && p >= 60;
      if (writtenPass !== practicalPass && (writtenPass || practicalPass)) {
        partial += 1;
      } else {
        fail += 1;
      }
    }
    return { pass, fail, partial, inProgress };
  }

  private async groupByCert(filter: StatsFilterDto) {
    const where: Prisma.RegistrationWhereInput = {};
    if (filter.certType) where.certType = filter.certType;
    if (filter.level) where.level = filter.level;
    const certTypes: CertType[] = [CertType.AXIS, CertType.AXIS_C, CertType.AXIS_H];
    const out: { certType: CertType; registered: number; passed: number }[] = [];
    for (const c of certTypes) {
      if (filter.certType && filter.certType !== c) continue;
      const [registered, passed] = await Promise.all([
        this.prisma.registration.count({ where: { ...where, certType: c } }),
        this.prisma.examSession.count({
          where: {
            certType: c,
            level: filter.level ?? undefined,
            status: ExamSessionStatus.GRADED,
            passed: true,
          },
        }),
      ]);
      out.push({ certType: c, registered, passed });
    }
    return out;
  }

  private aggregateAverages(rows: { subjectName: string; percentage: number }[]) {
    const m = new Map<string, { sum: number; n: number }>();
    for (const r of rows) {
      const a = m.get(r.subjectName) ?? { sum: 0, n: 0 };
      a.sum += r.percentage;
      a.n += 1;
      m.set(r.subjectName, a);
    }
    return [...m.entries()].map(([subject, a]) => ({
      subject,
      avgScore: a.n > 0 ? Math.round((a.sum / a.n) * 10) / 10 : 0,
    }));
  }

  private buildHeatmap(
    accessor: (graded: unknown) => { subject: string; sessionId: string; value: number }[],
    sessionIds: string[],
  ) {
    const cells = accessor(null);
    const sessionToRound = new Map<string, number>();
    sessionIds.forEach((id, idx) => sessionToRound.set(id, Math.floor(idx / 10) + 1));
    const m = new Map<string, Map<number, { sum: number; n: number }>>();
    for (const c of cells) {
      const round = sessionToRound.get(c.sessionId) ?? 1;
      const subj = m.get(c.subject) ?? new Map<number, { sum: number; n: number }>();
      const cell = subj.get(round) ?? { sum: 0, n: 0 };
      cell.sum += c.value;
      cell.n += 1;
      subj.set(round, cell);
      m.set(c.subject, subj);
    }
    const out: { subject: string; round: number; avgScore: number }[] = [];
    for (const [subject, byRound] of m) {
      for (const [round, cell] of byRound) {
        out.push({
          subject,
          round,
          avgScore: cell.n > 0 ? Math.round((cell.sum / cell.n) * 10) / 10 : 0,
        });
      }
    }
    return out;
  }

  private aggregatePractical(
    essays: { taskId: string; earnedPoints: number | null }[],
    taskById: Map<string, { id: string; title: string; points: number; level: CertLevel; part: ExamPart }>,
  ) {
    const m = new Map<string, { sum: number; n: number; max: number; title: string }>();
    for (const e of essays) {
      if (e.earnedPoints == null) continue;
      const t = taskById.get(e.taskId);
      if (!t) continue;
      const a = m.get(t.id) ?? { sum: 0, n: 0, max: t.points, title: t.title };
      a.sum += e.earnedPoints;
      a.n += 1;
      m.set(t.id, a);
    }
    return [...m.values()].map((a) => ({
      task: a.title,
      avgScore: a.n > 0 && a.max > 0 ? Math.round((a.sum / a.n / a.max) * 1000) / 10 : 0,
    }));
  }

  private certLabel(c: CertType): string {
    return c === CertType.AXIS ? 'AXIS' : c === CertType.AXIS_C ? 'AXIS-C' : 'AXIS-H';
  }

  private eventLevel(t: ProctorEventType): 'HIGH' | 'MEDIUM' | 'INFO' {
    if (t === ProctorEventType.AI_FLAG_CONFIRMED || t === ProctorEventType.PHONE_DETECTED) return 'HIGH';
    if (
      t === ProctorEventType.AI_FLAG_SUSPICIOUS ||
      t === ProctorEventType.MULTIPLE_FACES ||
      t === ProctorEventType.FACE_NOT_DETECTED
    ) return 'MEDIUM';
    return 'INFO';
  }

  private eventLabel(t: ProctorEventType): string {
    return t.replace(/_/g, ' ').toLowerCase();
  }
}

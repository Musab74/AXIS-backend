import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ExamSessionStatus,
  ProctorEventType,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../integrations/redis/redis.service';
import { MonitorHeartbeatService } from './monitor-heartbeat.service';
import { ExamSessionPauseService } from './exam-session-pause.service';

const RECENT_EVENT_LIMIT = 50;
/**
 * A candidate counts as "live" if we've seen any authenticated proctor
 * activity (heartbeat) within this many ms. The 30 s window matches the
 * 3 s thumbnail cadence × ~10 missed pings, which lines up with a typical
 * laptop sleep / network blip.
 */
export const HEARTBEAT_LIVE_MS = 30_000;
/**
 * Disconnected candidates are kept in the live list this long before we hide
 * them — gives the proctor a chance to see "who just dropped" while still
 * allowing the row to fall off if they truly abandoned the exam.
 */
export const DISCONNECT_GRACE_MS = 5 * 60_000;

export type LiveStatus =
  | 'normal'
  | 'warning'
  | 'danger'
  | 'disconnected'
  | 'submitted'
  | 'terminated';

export interface LiveSessionRow {
  sessionId: string;
  candidateName: string;
  examName: string;
  level: string;
  progressPct: number;
  warnings: number;
  status: LiveStatus;
  /** Epoch-ms of the last heartbeat for this session (null = never seen). */
  lastSeenAt: number | null;
}

export interface LiveSummary {
  inProgress: boolean;
  examName: string | null;
  takers: number;
  warnings: number;
}

@Injectable()
export class AdminMonitorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly heartbeat: MonitorHeartbeatService,
    private readonly redis: RedisService,
    private readonly pause: ExamSessionPauseService,
  ) {}

  async listLive(): Promise<LiveSessionRow[]> {
    const now = Date.now();
    // Submitted / terminated sessions only stick around for a few minutes —
    // long enough for the proctor to see "they finished" without piling up
    // an ever-growing wall of past sessions.
    const recentEndCutoff = new Date(now - DISCONNECT_GRACE_MS);
    const sessions = await this.prisma.examSession.findMany({
      where: {
        OR: [
          {
            status: ExamSessionStatus.IN_PROGRESS,
            startedAt: { not: null },
          },
          {
            status: { in: [ExamSessionStatus.SUBMITTED, ExamSessionStatus.TERMINATED] },
            submittedAt: { gte: recentEndCutoff },
          },
        ],
      },
      include: {
        user: { select: { name: true } },
        answers: { select: { selectedChoice: true } },
      },
      orderBy: { startedAt: 'desc' },
    });

    // Redis powers the disconnect-detection layer. When it's unavailable,
    // fall back to "trust the DB" so a transient Redis outage doesn't make
    // every live candidate suddenly look disconnected to the proctor.
    const redisUp = this.redis.isReady();
    const heartbeats = redisUp
      ? await this.heartbeat.getLastSeenMany(sessions.map((s) => s.id))
      : new Map<string, number>();

    return sessions
      .map((s) => {
        const answered = s.answers.filter((a) => a.selectedChoice != null).length;
        const total = Math.max(s.answers.length, 1);
        const progressPct = Math.round((answered / total) * 100);
        const warnings = s.proctorWarnings;
        const lastSeen = heartbeats.get(s.id) ?? null;
        const status = this.deriveStatus(s.status, warnings, lastSeen, now, redisUp);
        return {
          sessionId: s.id,
          candidateName: s.user.name,
          examName: `${this.certLabel(s.certType)} ${s.level}`,
          level: s.level,
          progressPct,
          warnings,
          status,
          lastSeenAt: lastSeen,
        };
      })
      // Drop disconnected sessions whose grace window has expired AND that
      // never had any heartbeat (i.e. the proctor already had time to react,
      // and no signal is coming back). Keeps the panel tight in production.
      .filter((row) => {
        if (row.status !== 'disconnected') return true;
        if (row.lastSeenAt == null) {
          // Started but never sent a heartbeat — only show for the grace window
          // measured from `startedAt` (handled by the DB query above for ended
          // sessions; for never-connected IN_PROGRESS we just keep them).
          return true;
        }
        return now - row.lastSeenAt < DISCONNECT_GRACE_MS;
      });
  }

  async getDetail(id: string) {
    const session = await this.prisma.examSession.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true, userId: true } },
        answers: { select: { id: true, selectedChoice: true, flagged: true } },
      },
    });
    if (!session) throw new NotFoundException('Session not found');

    const recentEvents = await this.prisma.proctoringEvent.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: 'desc' },
      take: RECENT_EVENT_LIMIT,
    });

    const answered = session.answers.filter((a) => a.selectedChoice != null).length;
    const total = Math.max(session.answers.length, 1);
    const timerPaused = await this.pause.isPaused(id);

    return {
      sessionId: session.id,
      candidate: session.user,
      certType: session.certType,
      level: session.level,
      status: session.status,
      startedAt: session.startedAt,
      hardDeadline: session.hardDeadline,
      submittedAt: session.submittedAt,
      progressPct: Math.round((answered / total) * 100),
      answered,
      total,
      warnings: session.proctorWarnings,
      timerPaused,
      events: recentEvents.map((e) => {
        // `metadata.screenEvidenceUrl` is populated by the AI proctor when it
        // confirms cheating AND the candidate's screen share was active. Old
        // events (and events without an active share) keep this null.
        const meta = (e.metadata ?? {}) as Record<string, unknown>;
        const screenEvidenceUrl =
          typeof meta.screenEvidenceUrl === 'string' ? meta.screenEvidenceUrl : null;
        return {
          id: e.id,
          type: e.eventType,
          createdAt: e.createdAt,
          captionKo: e.captionKo,
          captionEn: e.captionEn,
          severity: e.severity,
          evidenceUrl: e.evidenceUrl,
          screenEvidenceUrl,
        };
      }),
    };
  }

  async summary(): Promise<LiveSummary> {
    const now = Date.now();
    const [active, warningCount] = await Promise.all([
      this.prisma.examSession.findMany({
        where: { status: ExamSessionStatus.IN_PROGRESS },
        select: { id: true, certType: true, level: true, proctorWarnings: true },
      }),
      this.prisma.proctoringEvent.count({
        where: {
          createdAt: { gte: new Date(now - 60 * 60 * 1000) },
          eventType: {
            in: [
              ProctorEventType.AI_FLAG_CONFIRMED,
              ProctorEventType.AI_FLAG_SUSPICIOUS,
              ProctorEventType.MULTIPLE_FACES,
              ProctorEventType.PHONE_DETECTED,
            ],
          },
        },
      }),
    ]);
    // Only count candidates who have actually pinged within the live window —
    // otherwise the "1 takers" badge in the header stays lit for hours after
    // someone closes their laptop mid-exam. When Redis is down we can't read
    // heartbeats, so trust the DB status (everything IN_PROGRESS counts).
    const redisUp = this.redis.isReady();
    const heartbeats = redisUp
      ? await this.heartbeat.getLastSeenMany(active.map((s) => s.id))
      : new Map<string, number>();
    const liveSessions = redisUp
      ? active.filter((s) => {
          const ts = heartbeats.get(s.id);
          return ts != null && now - ts < HEARTBEAT_LIVE_MS;
        })
      : active;
    if (liveSessions.length === 0) {
      return { inProgress: false, examName: null, takers: 0, warnings: 0 };
    }
    const first = liveSessions[0];
    return {
      inProgress: true,
      examName: `${this.certLabel(first.certType)} ${first.level}`,
      takers: liveSessions.length,
      warnings: warningCount,
    };
  }

  /**
   * Map (DB status × warning count × heartbeat freshness) → admin UI status.
   * The heartbeat-derived `disconnected` only applies to sessions the DB still
   * thinks are live; once SUBMITTED/TERMINATED, those terminal states win.
   */
  private deriveStatus(
    status: ExamSessionStatus,
    warnings: number,
    lastSeen: number | null,
    now: number,
    redisUp: boolean,
  ): LiveStatus {
    if (status === ExamSessionStatus.SUBMITTED) return 'submitted';
    if (status === ExamSessionStatus.TERMINATED) return 'terminated';
    // Without Redis we can't tell connected from disconnected — degrade to the
    // pre-heartbeat behaviour (warning-count derived) so the proctor doesn't
    // see a sea of false-positive offline rows during a Redis hiccup.
    if (redisUp && (lastSeen == null || now - lastSeen > HEARTBEAT_LIVE_MS)) {
      return 'disconnected';
    }
    if (warnings >= 3) return 'danger';
    if (warnings >= 1) return 'warning';
    return 'normal';
  }

  private certLabel(c: string): string {
    return c === 'AXIS' ? 'AXIS' : c === 'AXIS_C' ? 'AXIS-C' : c === 'AXIS_H' ? 'AXIS-H' : c;
  }
}

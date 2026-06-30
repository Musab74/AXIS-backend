import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { ExamSessionStatus, Prisma, ProctorEventType } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { ExamSessionGateway } from '../../websocket/exam-session.gateway';
import { CbtSessionsService } from '../cbtSessions/cbt-sessions.service';
import { AdminMonitorGateway } from './admin-monitor.gateway';
import { AdminNotificationsService } from '../adminNotifications/admin-notifications.service';
import { ExamSessionPauseService } from './exam-session-pause.service';
import { MonitorHeartbeatService } from './monitor-heartbeat.service';

const FULLSCREEN_WARNING_THRESHOLD = 3;

export interface MonitorActionResult {
  ok: true;
  sessionId: string;
  action: 'warn' | 'pause' | 'resume' | 'extend' | 'terminate';
  timerPaused?: boolean;
  hardDeadline?: string | null;
  status?: ExamSessionStatus;
}

@Injectable()
export class AdminMonitorActionsService {
  private readonly logger = new Logger(AdminMonitorActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pause: ExamSessionPauseService,
    private readonly examGateway: ExamSessionGateway,
    private readonly adminMonitor: AdminMonitorGateway,
    @Inject(forwardRef(() => AdminNotificationsService))
    private readonly notifications: AdminNotificationsService,
    private readonly heartbeat: MonitorHeartbeatService,
    @Inject(forwardRef(() => CbtSessionsService))
    private readonly cbtSessions: CbtSessionsService,
  ) {}

  async warn(actorId: string, sessionId: string, message?: string): Promise<MonitorActionResult> {
    const session = await this.requireInProgress(sessionId);
    const text =
      message?.trim() ||
      'Proctor has issued a warning. Please follow exam rules and return your attention to the exam.';

    await this.prisma.proctoringEvent.create({
      data: {
        sessionId,
        eventType: ProctorEventType.MANUAL_FLAG,
        metadata: {
          kind: 'ADMIN_WARNING',
          message: text,
          actorId,
          source: 'ADMIN',
        } as Prisma.InputJsonValue,
        captionKo: '감독관 수동 경고',
        captionEn: 'Manual proctor warning',
        severity: 'MEDIUM',
      },
    });

    await this.examGateway.emitCandidateEvent(sessionId, 'exam:warning', {
      level: 'warning',
      reason: 'ADMIN_WARNING',
      message: text,
    });

    await this.adminMonitor.emitAlert({
      sessionId,
      level: 'MEDIUM',
      message: text,
      ts: Date.now(),
    });

    void this.notifications.notify({
      category: 'CHEATING',
      titleKo: '감독관 수동 경고',
      titleEn: 'Manual proctor warning',
      bodyKo: text,
      bodyEn: text,
      severity: 'MEDIUM',
      href: '/monitoring',
      meta: { sessionId, actorId },
    });

    return { ok: true, sessionId, action: 'warn', status: session.status };
  }

  async togglePause(
    actorId: string,
    sessionId: string,
    reason?: string,
  ): Promise<MonitorActionResult> {
    const session = await this.requireInProgress(sessionId);
    const existing = await this.pause.getPauseState(sessionId);

    if (existing) {
      const elapsedMs = Date.now() - existing.pausedAt;
      const newDeadline = session.hardDeadline
        ? new Date(session.hardDeadline.getTime() + elapsedMs)
        : null;

      const updated = await this.prisma.examSession.update({
        where: { id: sessionId },
        data: { hardDeadline: newDeadline },
      });

      await this.pause.clearPaused(sessionId);

      await this.prisma.proctoringEvent.create({
        data: {
          sessionId,
          eventType: ProctorEventType.MANUAL_FLAG,
          metadata: {
            kind: 'ADMIN_TIMER_RESUME',
            actorId,
            elapsedMs,
            source: 'ADMIN',
          } as Prisma.InputJsonValue,
          captionKo: '감독관 타이머 재개',
          captionEn: 'Proctor resumed timer',
          severity: 'INFO',
        },
      });

      await this.examGateway.emitCandidateEvent(sessionId, 'exam:timer-resumed', {
        hardDeadline: updated.hardDeadline?.toISOString() ?? null,
        elapsedMs,
      });

      await this.adminMonitor.emitAlert({
        sessionId,
        level: 'INFO',
        message: `Timer resumed (+${Math.round(elapsedMs / 1000)}s compensation)`,
        ts: Date.now(),
      });

      return {
        ok: true,
        sessionId,
        action: 'resume',
        timerPaused: false,
        hardDeadline: updated.hardDeadline?.toISOString() ?? null,
        status: updated.status,
      };
    }

    const pauseReason = reason?.trim() || 'Exam paused by proctor for a technical issue.';
    const pausedAt = Date.now();
    await this.pause.setPaused(sessionId, { pausedAt, actorId, reason: pauseReason });

    await this.prisma.proctoringEvent.create({
      data: {
        sessionId,
        eventType: ProctorEventType.MANUAL_FLAG,
        metadata: {
          kind: 'ADMIN_TIMER_PAUSE',
          actorId,
          reason: pauseReason,
          pausedAt,
          source: 'ADMIN',
        } as Prisma.InputJsonValue,
        captionKo: '감독관 타이머 정지',
        captionEn: 'Proctor paused timer',
        severity: 'INFO',
      },
    });

    await this.examGateway.emitCandidateEvent(sessionId, 'exam:timer-paused', {
      reason: pauseReason,
      pausedAt,
    });

    await this.adminMonitor.emitAlert({
      sessionId,
      level: 'INFO',
      message: pauseReason,
      ts: Date.now(),
    });

    return {
      ok: true,
      sessionId,
      action: 'pause',
      timerPaused: true,
      hardDeadline: session.hardDeadline?.toISOString() ?? null,
      status: session.status,
    };
  }

  async extend(
    actorId: string,
    sessionId: string,
    seconds: number,
  ): Promise<MonitorActionResult> {
    const session = await this.requireInProgress(sessionId);
    if (!session.hardDeadline) {
      throw new BadRequestException('Session has no hard deadline');
    }

    const updated = await this.prisma.examSession.update({
      where: { id: sessionId },
      data: {
        hardDeadline: new Date(session.hardDeadline.getTime() + seconds * 1000),
      },
    });

    await this.prisma.proctoringEvent.create({
      data: {
        sessionId,
        eventType: ProctorEventType.MANUAL_FLAG,
        metadata: {
          kind: 'ADMIN_TIME_EXTEND',
          actorId,
          seconds,
          source: 'ADMIN',
        } as Prisma.InputJsonValue,
        captionKo: `시간 ${seconds}초 연장`,
        captionEn: `Time extended by ${seconds}s`,
        severity: 'INFO',
      },
    });

    await this.examGateway.emitCandidateEvent(sessionId, 'exam:time-extended', {
      seconds,
      hardDeadline: updated.hardDeadline?.toISOString() ?? null,
    });

    await this.adminMonitor.emitAlert({
      sessionId,
      level: 'INFO',
      message: `Time extended by ${seconds}s`,
      ts: Date.now(),
    });

    return {
      ok: true,
      sessionId,
      action: 'extend',
      hardDeadline: updated.hardDeadline?.toISOString() ?? null,
      timerPaused: await this.pause.isPaused(sessionId),
      status: updated.status,
    };
  }

  async terminate(
    actorId: string,
    sessionId: string,
    reason?: string,
  ): Promise<MonitorActionResult> {
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      include: { user: { select: { name: true } } },
    });
    if (!session) throw new NotFoundException('Session not found');

    if (
      session.status === ExamSessionStatus.SUBMITTED ||
      session.status === ExamSessionStatus.GRADED
    ) {
      return {
        ok: true,
        sessionId,
        action: 'terminate',
        status: session.status,
        hardDeadline: session.hardDeadline?.toISOString() ?? null,
      };
    }

    if (session.status === ExamSessionStatus.TERMINATED) {
      return {
        ok: true,
        sessionId,
        action: 'terminate',
        status: session.status,
        hardDeadline: session.hardDeadline?.toISOString() ?? null,
      };
    }

    if (session.status !== ExamSessionStatus.IN_PROGRESS) {
      throw new BadRequestException(`Cannot terminate session in status ${session.status}`);
    }

    const text = reason?.trim() || 'Forced termination by proctor (Article 28).';
    const failReason = `Admin forced termination — ${text}`;

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.proctoringEvent.create({
        data: {
          sessionId,
          eventType: ProctorEventType.MANUAL_FLAG,
          metadata: {
            kind: 'ADMIN_TERMINATE',
            actorId,
            reason: text,
            source: 'ADMIN',
          } as Prisma.InputJsonValue,
          captionKo: '감독관 강제 종료',
          captionEn: 'Admin force terminate',
          severity: 'HIGH',
        },
      });

      return tx.examSession.update({
        where: { id: sessionId },
        data: {
          status: ExamSessionStatus.TERMINATED,
          submittedAt: new Date(),
          failReason,
          proctorWarnings: Math.max(session.proctorWarnings, FULLSCREEN_WARNING_THRESHOLD),
        },
      });
    });

    await this.pause.clearPaused(sessionId);
    void this.heartbeat.clear(sessionId);

    await this.examGateway.emitCandidateEvent(sessionId, 'exam:force-terminate', {
      reason: text,
    });

    await this.adminMonitor.emitAlert({
      sessionId,
      level: 'HIGH',
      message: text,
      ts: Date.now(),
    });

    void this.notifications.notify({
      category: 'CHEATING',
      titleKo: '감독관 강제 종료',
      titleEn: 'Admin force-terminated exam',
      bodyKo: `${session.user.name} — ${text}`,
      bodyEn: `${session.user.name} — ${text}`,
      severity: 'HIGH',
      href: '/monitoring',
      meta: { sessionId, actorId },
    });

    await this.emitSessionRow(updated, updated.proctorWarnings, session.user.name);

    void this.cbtSessions.closeRegistrationIfFinished(null, sessionId, 'strike-threshold');

    this.logger.warn(`Admin ${actorId} terminated session ${sessionId}: ${text}`);

    return {
      ok: true,
      sessionId,
      action: 'terminate',
      status: updated.status,
      hardDeadline: updated.hardDeadline?.toISOString() ?? null,
    };
  }

  private async requireInProgress(sessionId: string) {
    const session = await this.prisma.examSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');
    if (session.status !== ExamSessionStatus.IN_PROGRESS) {
      throw new BadRequestException(`Session is not in progress (status=${session.status})`);
    }
    return session;
  }

  private async emitSessionRow(
    session: { id: string; certType: string; level: string; proctorWarnings: number },
    warnings: number,
    candidateName = '',
  ): Promise<void> {
    void this.adminMonitor.emitSessionUpdate({
      sessionId: session.id,
      status: 'terminated',
      progressPct: 0,
      warnings,
      candidateName,
      examName: `${session.certType.replace('_', '-')} ${session.level}`,
    });
  }
}

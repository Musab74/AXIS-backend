import { Logger, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { RedisService } from '../../integrations/redis/redis.service';
import { AdminMonitorService, LiveSessionRow, LiveSummary } from './admin-monitor.service';

const SESSION_UPDATE_CHANNEL = 'admin:session-update';
const ALERT_CHANNEL = 'admin:exam-alert';
const LIVE_STATUS_CHANNEL = 'admin:live-status';
const WEBCAM_FRAME_CHANNEL = 'admin:webcam-frame';
const SCREEN_FRAME_CHANNEL = 'admin:screen-frame';
const MEDIA_PULSE_CHANNEL = 'admin:media-pulse';
const NOTIFICATION_CHANNEL = 'admin:notification';
const AI_ALERT_CHANNEL = 'proctor:ai-alert';
const ADMIN_ROOM = 'admin:monitor';
const sessionRoom = (sessionId: string): string => `monitor:session:${sessionId}`;

// Latest-frame cache used by the proctor-event evidence-attach path. The
// frontend already POSTs webcam + screen thumbnails every 5s while the exam
// is running; we mirror the most recent one into Redis with a short TTL so
// `CbtSessionsService.recordProctorEventInternal` can grab it on demand
// when a face/eye/identity heuristic fires (which itself debounces ≥3s).
// 60s gives a comfortable buffer for camera-stream startup gaps without
// risking stale evidence from before the violation actually happened.
const LAST_FRAME_TTL_SEC = 60;
export const LAST_WEBCAM_FRAME_KEY = (sessionId: string): string =>
  `proctor:lastframe:webcam:${sessionId}`;
export const LAST_SCREEN_FRAME_KEY = (sessionId: string): string =>
  `proctor:lastframe:screen:${sessionId}`;

// Lowercased JWT roles — must stay in parity with HTTP @Roles on the monitor controller.
const ADMIN_ROLES = new Set([
  'proctor',
  'exam_admin',
  'super_admin',
  'grading_admin',
  'expert',
]);

interface JwtPayload {
  sub?: string;
  userId?: string;
  roles?: string[];
}

export interface SessionUpdatePayload {
  sessionId: string;
  status: LiveSessionRow['status'];
  progressPct: number;
  warnings: number;
  candidateName: string;
  examName: string;
}

export interface ExamAlertPayload {
  sessionId: string;
  level: 'INFO' | 'MEDIUM' | 'HIGH';
  message: string;
  ts: number;
}

export interface MonitorFramePayload {
  sessionId: string;
  /** Base64-encoded JPEG without the `data:` prefix. Kept ≤ ~32 KB by the client. */
  imageBase64: string;
  ts: number;
}

export interface MediaPulsePayload {
  sessionId: string;
  channel: 'webcam' | 'screen';
  ts: number;
}

export interface AdminNotificationPayload {
  id: string;
  category: string;
  titleKo: string;
  titleEn: string;
  bodyKo: string;
  bodyEn: string;
  severity: 'INFO' | 'MEDIUM' | 'HIGH';
  href?: string;
  meta?: Record<string, unknown>;
  ts: number;
}

@WebSocketGateway({
  namespace: '/admin',
  cors: { origin: true, credentials: true },
  // Frames are tiny JPEGs (≤ 32 KB), but socket.io defaults to a 1 MB cap which
  // is well above what we send. Bumping for headroom on bursty multi-session views.
  maxHttpBufferSize: 4 * 1024 * 1024,
})
export class AdminMonitorGateway implements OnModuleInit, OnGatewayConnection {
  @WebSocketServer()
  private readonly server!: Server;

  private readonly logger = new Logger(AdminMonitorGateway.name);

  constructor(
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly monitor: AdminMonitorService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.redis.subscribe(SESSION_UPDATE_CHANNEL, (msg) => {
      try {
        const raw = JSON.parse(msg) as SessionUpdatePayload & { _tag?: string };
        if (this.wasLocallyEmitted(raw._tag)) return;
        const { _tag: _ignored, ...p } = raw;
        void _ignored;
        this.server?.to(ADMIN_ROOM).emit('exam:session-update', p);
      } catch (err) {
        this.logger.warn(`bad session-update payload: ${(err as Error).message}`);
      }
    });
    await this.redis.subscribe(ALERT_CHANNEL, (msg) => {
      try {
        const raw = JSON.parse(msg) as ExamAlertPayload & { _tag?: string };
        if (this.wasLocallyEmitted(raw._tag)) return;
        const { _tag: _ignored, ...p } = raw;
        void _ignored;
        this.server?.to(ADMIN_ROOM).emit('exam:alert', p);
      } catch (err) {
        this.logger.warn(`bad alert payload: ${(err as Error).message}`);
      }
    });
    await this.redis.subscribe(LIVE_STATUS_CHANNEL, (msg) => {
      try {
        const raw = JSON.parse(msg) as LiveSummary & { _tag?: string };
        if (this.wasLocallyEmitted(raw._tag)) return;
        const { _tag: _ignored, ...p } = raw;
        void _ignored;
        this.server?.to(ADMIN_ROOM).emit('exam:live-status', p);
      } catch (err) {
        this.logger.warn(`bad live-status payload: ${(err as Error).message}`);
      }
    });
    await this.redis.subscribe(WEBCAM_FRAME_CHANNEL, (msg) => {
      try {
        const raw = JSON.parse(msg) as MonitorFramePayload & { _tag?: string };
        if (this.wasLocallyEmitted(raw._tag)) return;
        const { _tag: _ignored, ...p } = raw;
        void _ignored;
        // Per-session room only — frames are heavy, never broadcast.
        this.server?.to(sessionRoom(p.sessionId)).emit('monitor:webcam-frame', p);
      } catch (err) {
        this.logger.warn(`bad webcam-frame payload: ${(err as Error).message}`);
      }
    });
    await this.redis.subscribe(SCREEN_FRAME_CHANNEL, (msg) => {
      try {
        const raw = JSON.parse(msg) as MonitorFramePayload & { _tag?: string };
        if (this.wasLocallyEmitted(raw._tag)) return;
        const { _tag: _ignored, ...p } = raw;
        void _ignored;
        this.server?.to(sessionRoom(p.sessionId)).emit('monitor:screen-frame', p);
      } catch (err) {
        this.logger.warn(`bad screen-frame payload: ${(err as Error).message}`);
      }
    });
    await this.redis.subscribe(NOTIFICATION_CHANNEL, (msg) => {
      try {
        const raw = JSON.parse(msg) as AdminNotificationPayload & { _tag?: string };
        if (this.wasLocallyEmitted(raw._tag)) return;
        const { _tag: _ignored, ...p } = raw;
        void _ignored;
        this.server?.to(ADMIN_ROOM).emit('notification:new', p);
      } catch (err) {
        this.logger.warn(`bad notification payload: ${(err as Error).message}`);
      }
    });
    await this.redis.subscribe(MEDIA_PULSE_CHANNEL, (msg) => {
      try {
        const raw = JSON.parse(msg) as MediaPulsePayload & { _tag?: string };
        if (this.wasLocallyEmitted(raw._tag)) return;
        const { _tag: _ignored, ...p } = raw;
        void _ignored;
        this.server?.to(ADMIN_ROOM).emit('monitor:media-pulse', p);
      } catch (err) {
        this.logger.warn(`bad media-pulse payload: ${(err as Error).message}`);
      }
    });
    // Bridge AI proctor alerts (published on /ws firehose) into the /admin
    // monitor feed so MonitoringPage can show + jump without a second socket.
    // Local emit only — do NOT re-publish, or every worker would amplify the alert.
    await this.redis.subscribe(AI_ALERT_CHANNEL, (msg) => {
      try {
        const ai = JSON.parse(msg) as {
          sessionId: string;
          severity?: string;
          captionKo?: string;
          captionEn?: string;
          type?: string;
          ts?: number;
        };
        if (!ai.sessionId) return;
        const level: ExamAlertPayload['level'] =
          ai.severity === 'HIGH' ? 'HIGH' : ai.severity === 'MED' || ai.severity === 'MEDIUM' ? 'MEDIUM' : 'INFO';
        const message =
          ai.captionKo?.trim() ||
          ai.captionEn?.trim() ||
          ai.type ||
          'AI proctor alert';
        this.server?.to(ADMIN_ROOM).emit('exam:alert', {
          sessionId: ai.sessionId,
          level,
          message,
          ts: ai.ts ?? Date.now(),
        } satisfies ExamAlertPayload);
      } catch (err) {
        this.logger.warn(`bad ai-alert bridge payload: ${(err as Error).message}`);
      }
    });
  }

  /**
   * Hybrid emit: hit the local Socket.io server immediately AND publish to
   * Redis. The Redis subscriber loop in onModuleInit then re-emits to the
   * SAME local server, which would normally double-deliver — but since we
   * dedupe by tracking which payloads we just sent locally, the local fan-out
   * also doesn't duplicate. The point of the local emit is that single-node
   * deployments stay functional when Redis is unreachable; multi-node
   * deployments still get cross-node fan-out via the publish.
   *
   * To avoid the double-delivery we tag each payload with a short-lived id and
   * skip the Redis-side re-emit if we just sent it locally.
   */
  private readonly recentLocalEmits = new Set<string>();
  private rememberLocal(id: string): void {
    this.recentLocalEmits.add(id);
    setTimeout(() => this.recentLocalEmits.delete(id), 5_000);
  }
  private wasLocallyEmitted(id: string | undefined): boolean {
    return id != null && this.recentLocalEmits.has(id);
  }

  async emitSessionUpdate(p: SessionUpdatePayload): Promise<void> {
    const tag = `s:${p.sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    this.rememberLocal(tag);
    this.server?.to(ADMIN_ROOM).emit('exam:session-update', p);
    await this.redis.publish(SESSION_UPDATE_CHANNEL, JSON.stringify({ ...p, _tag: tag }));
  }

  async emitAlert(p: ExamAlertPayload): Promise<void> {
    const tag = `a:${p.sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    this.rememberLocal(tag);
    this.server?.to(ADMIN_ROOM).emit('exam:alert', p);
    await this.redis.publish(ALERT_CHANNEL, JSON.stringify({ ...p, _tag: tag }));
  }

  async emitNotification(p: AdminNotificationPayload): Promise<void> {
    const tag = `n:${p.id}:${Math.random().toString(36).slice(2, 8)}`;
    this.rememberLocal(tag);
    this.server?.to(ADMIN_ROOM).emit('notification:new', p);
    await this.redis.publish(NOTIFICATION_CHANNEL, JSON.stringify({ ...p, _tag: tag }));
  }

  async broadcastLiveStatus(): Promise<void> {
    let summary: LiveSummary;
    try {
      summary = await this.monitor.summary();
    } catch (err) {
      this.logger.warn(`live-status summary failed: ${(err as Error).message}`);
      return;
    }
    const tag = `l:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    this.rememberLocal(tag);
    this.server?.to(ADMIN_ROOM).emit('exam:live-status', summary);
    await this.redis.publish(LIVE_STATUS_CHANNEL, JSON.stringify({ ...summary, _tag: tag }));
  }

  /** Fan out a downscaled webcam thumbnail to every admin watching this session. */
  async emitWebcamFrame(p: MonitorFramePayload): Promise<void> {
    const tag = `w:${p.sessionId}:${p.ts}`;
    this.rememberLocal(tag);
    this.server?.to(sessionRoom(p.sessionId)).emit('monitor:webcam-frame', p);
    await this.redis.publish(WEBCAM_FRAME_CHANNEL, JSON.stringify({ ...p, _tag: tag }));
    void this.emitMediaPulse({ sessionId: p.sessionId, channel: 'webcam', ts: p.ts });
    // Best-effort: mirror the latest frame into Redis so a heuristic
    // proctor event (GAZE_AWAY, NO_FACE, etc.) can attach it as evidence.
    // Stored as `<ts>|<base64>` so consumers can sanity-check freshness.
    void this.redis.set(
      LAST_WEBCAM_FRAME_KEY(p.sessionId),
      `${p.ts}|${p.imageBase64}`,
      LAST_FRAME_TTL_SEC,
    );
  }

  /** Fan out a downscaled screen-capture thumbnail to admins watching this session. */
  async emitScreenFrame(p: MonitorFramePayload): Promise<void> {
    const tag = `c:${p.sessionId}:${p.ts}`;
    this.rememberLocal(tag);
    this.server?.to(sessionRoom(p.sessionId)).emit('monitor:screen-frame', p);
    await this.redis.publish(SCREEN_FRAME_CHANNEL, JSON.stringify({ ...p, _tag: tag }));
    void this.emitMediaPulse({ sessionId: p.sessionId, channel: 'screen', ts: p.ts });
    void this.redis.set(
      LAST_SCREEN_FRAME_KEY(p.sessionId),
      `${p.ts}|${p.imageBase64}`,
      LAST_FRAME_TTL_SEC,
    );
  }

  /** Lightweight roster signal — no image bytes; updates cam/screen chips for all admins. */
  async emitMediaPulse(p: MediaPulsePayload): Promise<void> {
    const tag = `m:${p.channel}:${p.sessionId}:${p.ts}`;
    this.rememberLocal(tag);
    this.server?.to(ADMIN_ROOM).emit('monitor:media-pulse', p);
    await this.redis.publish(MEDIA_PULSE_CHANNEL, JSON.stringify({ ...p, _tag: tag }));
  }

  async handleConnection(@ConnectedSocket() socket: Socket): Promise<void> {
    const token = this.extractToken(socket);
    if (!token) {
      socket.disconnect(true);
      return;
    }
    // Step 1: validate the token. The catch is scoped tightly so that ONLY a
    // JWT failure (bad signature / expired / malformed) disconnects the socket.
    let payload: JwtPayload;
    try {
      const secret = this.config.get<string>('jwt.accessSecret');
      payload = this.jwt.verify<JwtPayload>(token, { secret });
    } catch (err) {
      this.logger.debug(`admin WS rejected (jwt): ${(err as Error).message}`);
      socket.disconnect(true);
      return;
    }
    const roles = (payload.roles ?? []).map((r) => r.toLowerCase());
    if (!roles.some((r) => ADMIN_ROLES.has(r))) {
      socket.disconnect(true);
      return;
    }
    socket.data.userId = payload.userId ?? payload.sub;
    socket.data.roles = roles;
    socket.join(ADMIN_ROOM);

    // Step 2: best-effort initial summary. Any failure here (Redis hiccup,
    // pre-existing Prisma stale-types issue, transient DB error) MUST NOT
    // disconnect the now-authenticated client — the sweeper will re-broadcast
    // the next valid summary within a few seconds anyway.
    void this.monitor
      .summary()
      .then((summary) => socket.emit('exam:live-status', summary))
      .catch((err) =>
        this.logger.warn(`initial summary emit failed: ${(err as Error).message}`),
      );
  }

  @SubscribeMessage('admin:ping')
  ping(): { ok: true } {
    return { ok: true };
  }

  /**
   * Admin opt-in to a single session's live webcam + screen frames. We use
   * per-session rooms because frames are heavy (~5–30 KB each, every 3 s) and
   * the firehose room would burn bandwidth on every admin who has the page open
   * but isn't actively viewing this candidate.
   */
  @SubscribeMessage('admin:watch-session')
  watchSession(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { sessionId?: string },
  ): { ok: true } {
    if (body?.sessionId) socket.join(sessionRoom(body.sessionId));
    return { ok: true };
  }

  @SubscribeMessage('admin:unwatch-session')
  unwatchSession(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { sessionId?: string },
  ): { ok: true } {
    if (body?.sessionId) socket.leave(sessionRoom(body.sessionId));
    return { ok: true };
  }

  private extractToken(socket: Socket): string | null {
    const auth = socket.handshake.auth as Record<string, unknown> | undefined;
    if (auth && typeof auth.token === 'string') return auth.token;
    const header = socket.handshake.headers?.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length);
    }
    const q = socket.handshake.query?.token;
    if (typeof q === 'string') return q;
    return null;
  }
}

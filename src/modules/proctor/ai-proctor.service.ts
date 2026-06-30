import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ExamSession,
  ExamSessionStatus,
  PenaltyStatus,
  Prisma,
  ProctorEventType,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import {
  GeminiVisionService,
  type GeminiScreenResult,
} from '../../integrations/googleGemini/google-gemini.service';
import {
  ClaudeProctorService,
  type ClaudeProctorResult,
} from '../../integrations/anthropic/claude-proctor.service';
import { NcObjectStorageService } from '../../integrations/ncObjectStorage/nc-object-storage.service';
import { RedisService } from '../../integrations/redis/redis.service';
import { AdminGateway } from '../../websocket/admin.gateway';
import { MonitorHeartbeatService } from '../adminMonitor/monitor-heartbeat.service';
import { CbtSessionsService } from '../cbtSessions/cbt-sessions.service';

/**
 * The schema's `ProctoringEvent` model only has `severity` (string), `captionKo`,
 * `captionEn`, `evidenceUrl`, `videoClipUrl`, `retainUntil`, `metadata` (JSON).
 * The earlier code expected dedicated AI columns (`aiTier`, `aiSeverity`,
 * `aiCaptionKo`, etc.) and a top-level `dedupeKey` — those don't exist. We
 * marshal those into `metadata` JSON so the Prisma calls actually validate at
 * runtime instead of throwing on every snapshot. See proctor-detection-gap-fix
 * plan, Step 2.
 */
type AiTier = 'GEMINI' | 'CLAUDE';
type AiSeverity = 'LOW' | 'MED' | 'HIGH';

/** Gemini flag values that should also fire a `PHONE_DETECTED` strike. */
const PHONE_CLASS_FLAGS: ReadonlySet<string> = new Set([
  'PHONE_IN_FRAME',
  'OTHER_DEVICE_IN_FRAME',
]);

/**
 * Gemini flag values that should also fire a `GAZE_AWAY` strike — i.e. the
 * AI tier confirms the candidate looked off-screen. Mirrors how phone-class
 * flags fire PHONE_DETECTED. Per Duolingo-style strict mode (user choice),
 * any AI-confirmed look-away counts as a strike on the same 3-strike budget
 * as the local face-api gaze detection. The two channels are intentionally
 * additive — face-api fires fast (~500 ms) for instant pressure; the AI
 * fires every ~10 s as the authoritative second opinion.
 */
const GAZE_CLASS_FLAGS: ReadonlySet<string> = new Set(['LOOKING_OFF_SCREEN']);

export type AiVerdict = 'OK' | 'LOW' | 'MED' | 'HIGH';

export interface AiReviewResult {
  aiVerdict: AiVerdict;
  captionKo: string | null;
  captionEn: string | null;
  ruleBroken: string | null;
  evidenceUrl: string | null;
  /** True when the pipeline degraded (Gemini timeout / Claude timeout / NCP fail). */
  degraded: boolean;
  /** Whether Claude was called this tick (false if rate-limited or Gemini cleared). */
  escalated: boolean;
  /** Whether the ProctoringEvent row was deduped against an earlier (sessionId, ts). */
  duplicate: boolean;
}

const CLAUDE_RL_TTL_SEC = 30;
const DEDUPE_TTL_SEC = 60;
/** Default Gemini suspicion threshold for general flags (hat, looking off, etc.) */
const GEMINI_SUSPICION_THRESHOLD = 0.5;
/**
 * Per-flag suspicion threshold overrides — used when a specific flag is the
 * only/primary signal. Phone-class flags get a lower bar (0.3) because (a)
 * phones are rarer than general "suspicious" patterns, (b) the cost of a
 * false negative (missed cheating) is much higher than a false positive
 * (one Claude call), and (c) Claude is the second-stage gate that confirms
 * before any strike. See plan Step 4.
 */
const PER_FLAG_THRESHOLDS: ReadonlyMap<string, number> = new Map([
  ['PHONE_IN_FRAME', 0.3],
  ['OTHER_DEVICE_IN_FRAME', 0.3],
  // Gaze gets the same low log-bar as phone (Duolingo-strict mode). Any
  // even tentative look-away gets persisted as AI_FLAG_SUSPICIOUS for audit;
  // strike-firing is still gated at GEMINI_ONLY_GAZE_CONFIDENCE = 0.5 so
  // borderline 0.3–0.5 cases don't penalize the candidate.
  ['LOOKING_OFF_SCREEN', 0.3],
]);
/**
 * Confidence bar required to short-circuit Claude when Redis is offline AND
 * the only flag is phone-class. Higher than the Gemini threshold so we don't
 * fire a strike on borderline frames without Claude's confirmation.
 */
const REDIS_FALLBACK_PHONE_CONFIDENCE = 0.6;
/**
 * Confidence bars for the Gemini-only fallback path used when Claude (Tier-2)
 * has no API key. Higher than the "should we call Claude" threshold (0.3 / 0.5)
 * because we no longer have an independent verifier — bumping the bar trades
 * recall for precision and cuts false positives. Phone-class gets a slightly
 * lower bar (0.6) because phones are the highest-cost cheating vector to miss
 * and Gemini is reasonably good at them at 480x360.
 */
const GEMINI_ONLY_PHONE_CONFIDENCE = 0.6;
const GEMINI_ONLY_OTHER_CONFIDENCE = 0.7;
/**
 * Lower confidence bar specifically for `LOOKING_OFF_SCREEN`. Gemini is very
 * accurate on gaze direction (it's literally pixels of where the iris is in
 * the frame) and we want Duolingo-style sensitivity: any reasonably confident
 * AI look-away should count as a strike, even without Claude verification.
 */
const GEMINI_ONLY_GAZE_CONFIDENCE = 0.5;
const RETAIN_DEFAULT_DAYS = 90;
const RETAIN_PENALTY_DAYS = 365 * 2;
const SIGNED_URL_TTL_SEC = 60 * 30; // 30 min — long enough for an admin's tab

@Injectable()
export class AiProctorService {
  private readonly logger = new Logger(AiProctorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gemini: GeminiVisionService,
    private readonly claude: ClaudeProctorService,
    private readonly ncp: NcObjectStorageService,
    private readonly redis: RedisService,
    private readonly adminGateway: AdminGateway,
    private readonly heartbeat: MonitorHeartbeatService,
    private readonly cbtSessions: CbtSessionsService,
  ) {}

  /**
   * Tier-1 → Tier-2 → evidence pipeline. ANY failure short-circuits to OK so
   * the exam is never blocked by AI infra hiccups.
   */
  async review(
    userId: string,
    body: {
      sessionId: string;
      ts: number;
      imageBase64: string;
      /** Optional accompanying screen-capture frame; persisted on confirmed cheating. */
      screenImageBase64?: string | null;
    },
  ): Promise<AiReviewResult> {
    const session = await this.requireOwnedInProgress(userId, body.sessionId);
    await this.heartbeat.markAlive(session.id);
    const frame = decodeImage(body.imageBase64);
    // Best-effort decode of the optional screen frame. A corrupt/oversized
    // screen blob must NOT tank the AI review — the webcam path is the
    // authoritative cheating signal; screen evidence is supplementary.
    let screenFrame: Buffer | null = null;
    if (body.screenImageBase64) {
      try {
        screenFrame = decodeImage(body.screenImageBase64);
      } catch (err) {
        this.logger.warn(`screen frame decode failed: ${(err as Error).message}`);
        screenFrame = null;
      }
    }

    // Idempotency: dedupe on (sessionId, ts) at the Redis layer + UNIQUE index.
    const dedupeKey = `t${body.ts}`;
    const dedupeRedisKey = `proctor:ai:dedupe:${body.sessionId}:${body.ts}`;
    if (this.redis.isReady()) {
      const fresh = await this.redis.setNxEx(dedupeRedisKey, DEDUPE_TTL_SEC);
      if (!fresh) {
        return this.duplicateResult();
      }
    }

    const ctx = {
      sessionId: session.id,
      userId,
      certType: session.certType,
      level: session.level,
      ts: body.ts,
    };

    const geminiRes = await this.gemini.screen(frame, ctx);
    if (geminiRes.degraded) {
      return this.degradedResult();
    }
    // Effective threshold = min over all returned flags' overrides, defaulting
    // to the general 0.5 bar. So a Gemini result with PHONE_IN_FRAME @ 0.35
    // crosses the bar (override = 0.3) even though it's below the general 0.5.
    const effectiveThreshold = this.effectiveSuspicionThreshold(geminiRes.flags);
    if (!geminiRes.suspicious || geminiRes.confidence < effectiveThreshold) {
      return this.okResult();
    }

    // Claude-offline fallback. When ANTHROPIC_API_KEY is intentionally absent
    // (e.g. budget pause, key rotation in progress, dev/staging without paid
    // creds), `claude.verifyAndCaption` would always degrade and the whole
    // pipeline would no-op — meaning the user's complaint of "AI not catching
    // anything" reproduces exactly. Instead, fall back to a Gemini-only verdict
    // gated by a higher confidence bar than the "should we call Claude" check.
    // Note: this path is only entered when Claude is *configured-offline*, NOT
    // when a configured Claude transiently errors — those still hit the normal
    // `claudeRes.degraded` branch below to avoid double-penalizing on hiccups.
    if (!this.claude.isConfigured()) {
      return this.handleClaudeOfflineFallback(
        session,
        userId,
        geminiRes,
        body.ts,
        frame,
        screenFrame,
        dedupeKey,
      );
    }

    // Cost cap — Claude is rate-limited to once per CLAUDE_RL_TTL_SEC per session.
    const claudeAllowed = await this.acquireClaudeSlot(session.id);
    if (!claudeAllowed) {
      // Redis-fallback path: when Redis is offline (acquireClaudeSlot returns
      // false because we fail-CLOSED to protect Claude's cost cap), AND the
      // Gemini flags are exclusively phone-class with confidence >= 0.6, we
      // emit a MED verdict + PHONE_DETECTED strike directly. This stops Redis
      // hiccups from giving a "free pass" on visible phone use, which is the
      // most expensive cheating vector to miss. See plan Step 4.
      const phoneOnly =
        geminiRes.flags.length > 0 &&
        geminiRes.flags.every((f) => PHONE_CLASS_FLAGS.has(f));
      if (
        !this.redis.isReady() &&
        phoneOnly &&
        geminiRes.confidence >= REDIS_FALLBACK_PHONE_CONFIDENCE
      ) {
        return this.handleRedisFallbackPhone(
          session,
          userId,
          geminiRes,
          body.ts,
          frame,
          screenFrame,
          dedupeKey,
        );
      }

      // Same Redis-offline safety net for gaze-only flags. We dispatch
      // through the Claude-offline helper because its decision matrix
      // already covers gaze with the right thresholds and strike wiring.
      // The candidate sees a MED look-away verdict and gets a GAZE_AWAY
      // strike — same outcome as if Claude had been reachable. (The
      // metadata will read fallbackReason='claude-not-configured' which is
      // technically true at this code path: Redis being down forced us
      // off the Claude path.)
      const gazeOnly =
        geminiRes.flags.length > 0 &&
        geminiRes.flags.every((f) => GAZE_CLASS_FLAGS.has(f));
      if (
        !this.redis.isReady() &&
        gazeOnly &&
        geminiRes.confidence >= GEMINI_ONLY_GAZE_CONFIDENCE
      ) {
        return this.handleClaudeOfflineFallback(
          session,
          userId,
          geminiRes,
          body.ts,
          frame,
          screenFrame,
          dedupeKey,
        );
      }

      const eventId = await this.persistSuspiciousOnly(
        session,
        geminiRes,
        body.ts,
        dedupeKey,
      );
      await this.publishAlert({
        sessionId: session.id,
        userId,
        eventId,
        type: 'AI_FLAG_SUSPICIOUS',
        severity: 'LOW',
        captionKo: this.geminiHintKo(geminiRes),
        captionEn: this.geminiHintEn(geminiRes),
        ruleBroken: null,
        evidenceUrl: null,
        videoClipUrl: null,
        ts: body.ts,
      });
      return {
        aiVerdict: 'OK',
        captionKo: null,
        captionEn: null,
        ruleBroken: null,
        evidenceUrl: null,
        degraded: false,
        escalated: false,
        duplicate: false,
      };
    }

    const claudeRes = await this.claude.verifyAndCaption(frame, geminiRes, ctx);
    if (claudeRes.degraded) {
      return this.degradedResult();
    }
    if (!claudeRes.confirmed) {
      const eventId = await this.persistSuspiciousOnly(
        session,
        geminiRes,
        body.ts,
        dedupeKey,
      );
      await this.publishAlert({
        sessionId: session.id,
        userId,
        eventId,
        type: 'AI_FLAG_SUSPICIOUS',
        severity: 'LOW',
        captionKo: this.geminiHintKo(geminiRes),
        captionEn: this.geminiHintEn(geminiRes),
        ruleBroken: null,
        evidenceUrl: null,
        videoClipUrl: null,
        ts: body.ts,
      });
      return {
        aiVerdict: 'OK',
        captionKo: null,
        captionEn: null,
        ruleBroken: null,
        evidenceUrl: null,
        degraded: false,
        escalated: true,
        duplicate: false,
      };
    }

    // Confirmed — upload evidence + persist + emit. The screen frame is
    // optional: if the candidate hasn't granted screen share, or NCP is
    // misconfigured, we still persist the webcam evidence and the
    // metadata.screenEvidenceUrl is null.
    const evidenceUrl = await this.uploadEvidenceFrame(session, body.ts, frame);
    const screenEvidenceUrl = screenFrame
      ? await this.uploadScreenEvidenceFrame(session, body.ts, screenFrame)
      : null;
    const retainUntil = await this.computeRetainUntil(session);
    const event = await this.prisma.proctoringEvent.create({
      data: {
        sessionId: session.id,
        eventType: ProctorEventType.AI_FLAG_CONFIRMED,
        severity: claudeRes.severity,
        captionKo: claudeRes.captionKo,
        captionEn: claudeRes.captionEn,
        evidenceUrl,
        retainUntil,
        metadata: {
          source: 'SERVER',
          aiTier: 'CLAUDE' as AiTier,
          aiRuleBroken: claudeRes.ruleBroken,
          aiConfidence: geminiRes.confidence,
          dedupeKey,
          screenEvidenceUrl,
          tier1: {
            confidence: geminiRes.confidence,
            flags: geminiRes.flags,
            modelMs: geminiRes.modelMs,
            inputTokens: geminiRes.inputTokens,
            outputTokens: geminiRes.outputTokens,
          },
          tier2: {
            modelMs: claudeRes.modelMs,
          },
        } as Prisma.InputJsonValue,
      },
    });

    await this.publishAlert({
      sessionId: session.id,
      userId,
      eventId: event.id,
      type: 'AI_FLAG_CONFIRMED',
      severity: claudeRes.severity,
      captionKo: claudeRes.captionKo,
      captionEn: claudeRes.captionEn,
      ruleBroken: claudeRes.ruleBroken,
      evidenceUrl,
      videoClipUrl: null,
      ts: body.ts,
    });

    // If Gemini flagged a phone (or other device) AND Claude confirmed the
    // verdict, also fire a PHONE_DETECTED strike via the CBT session service so
    // `proctorWarnings` advances and the 3-strike termination rule applies.
    // This is the missing wiring the proctor-detection-gap-fix plan added.
    const phoneFlagged = geminiRes.flags.some((f) => PHONE_CLASS_FLAGS.has(f));
    if (phoneFlagged) {
      try {
        await this.cbtSessions.recordSystemProctorEvent(
          session.id,
          ProctorEventType.PHONE_DETECTED,
          {
            origin: 'AI_FLAG_CONFIRMED',
            aiEventId: event.id,
            flags: geminiRes.flags,
            severity: claudeRes.severity,
            ruleBroken: claudeRes.ruleBroken,
            ts: body.ts,
          },
        );
      } catch (err) {
        // Non-fatal — the AI_FLAG_CONFIRMED row already persisted, the strike
        // is the cherry on top. Don't block the candidate response on this.
        this.logger.warn(`PHONE_DETECTED strike write failed: ${(err as Error).message}`);
      }
    }

    // Same wiring for LOOKING_OFF_SCREEN — Duolingo-strict mode (user choice).
    // The AI tier acts as the authoritative second opinion on gaze. Local
    // face-api may have already striked once at the 500 ms sustain mark; the
    // AI strike here is additive and counts toward the same 3-strike budget
    // (so a sustained look-away can take down a session within a single AI
    // tick if face-api also struck). This is intentional.
    const gazeFlagged = geminiRes.flags.some((f) => GAZE_CLASS_FLAGS.has(f));
    if (gazeFlagged) {
      try {
        await this.cbtSessions.recordSystemProctorEvent(
          session.id,
          ProctorEventType.GAZE_AWAY,
          {
            origin: 'AI_FLAG_CONFIRMED',
            aiEventId: event.id,
            flags: geminiRes.flags,
            severity: claudeRes.severity,
            ruleBroken: claudeRes.ruleBroken,
            confidence: geminiRes.confidence,
            ts: body.ts,
          },
        );
      } catch (err) {
        this.logger.warn(`GAZE_AWAY strike write failed: ${(err as Error).message}`);
      }
    }

    return {
      aiVerdict: claudeRes.severity,
      captionKo: claudeRes.captionKo,
      captionEn: claudeRes.captionEn,
      ruleBroken: claudeRes.ruleBroken,
      evidenceUrl,
      degraded: false,
      escalated: true,
      duplicate: false,
    };
  }

  /**
   * Persist the audio-clip event with a paired still frame. Both the webm and
   * the JPEG are uploaded to NCP under the same retainUntil window.
   */
  async recordVoiceClip(
    userId: string,
    body: {
      sessionId: string;
      ts: number;
      peakDb?: number;
      durationMs?: number;
      clipBuffer: Buffer;
      clipMime: string;
      stillFrame: Buffer | null;
    },
  ): Promise<{ eventId: string; videoClipUrl: string | null; evidenceUrl: string | null }> {
    // Voice-clip uploads race the client's termination POST on the strike
    // threshold (and on mic-disconnect). The tiny JSON terminate request
    // usually wins, flipping the session to TERMINATED before the multipart
    // clip lands. Using the strict IN_PROGRESS gate here silently drops the
    // ONLY proof that justifies the termination — the AUDIO_HIGH event row
    // with its videoClipUrl is what the admin EvidenceModal renders. The
    // relaxed gate below accepts in-progress sessions normally and also
    // permits a short grace window after a forced termination so the last
    // clip can still be persisted as evidence.
    const session = await this.requireOwnedActiveOrRecentlyTerminated(
      userId,
      body.sessionId,
    );
    await this.heartbeat.markAlive(session.id);
    const dedupeKey = `audio-${body.ts}`;
    const dedupeRedisKey = `proctor:ai:dedupe:${body.sessionId}:audio:${body.ts}`;
    if (this.redis.isReady()) {
      const fresh = await this.redis.setNxEx(dedupeRedisKey, DEDUPE_TTL_SEC);
      if (!fresh) {
        const existing = await this.findByDedupeKey(session.id, dedupeKey);
        if (existing) {
          return {
            eventId: existing.id,
            videoClipUrl: existing.videoClipUrl,
            evidenceUrl: existing.evidenceUrl,
          };
        }
      }
    }

    const retainUntil = await this.computeRetainUntil(session);
    const videoClipUrl = await this.uploadAudioClip(
      session,
      body.ts,
      body.clipBuffer,
      body.clipMime,
    );
    const evidenceUrl = body.stillFrame
      ? await this.uploadEvidenceFrame(session, body.ts, body.stillFrame)
      : null;

    const event = await this.prisma.proctoringEvent.create({
      data: {
        sessionId: session.id,
        eventType: ProctorEventType.AUDIO_HIGH,
        severity: 'MED' as AiSeverity,
        captionKo: '음성 활동이 감지되었습니다.',
        captionEn: 'Voice activity detected.',
        evidenceUrl,
        videoClipUrl,
        retainUntil,
        metadata: {
          source: 'SERVER',
          aiTier: null,
          aiRuleBroken: 'AUDIO_HIGH',
          dedupeKey,
          peakDb: body.peakDb ?? null,
          durationMs: body.durationMs ?? null,
        } as Prisma.InputJsonValue,
      },
    });

    await this.publishAlert({
      sessionId: session.id,
      userId,
      eventId: event.id,
      type: 'AUDIO_HIGH',
      severity: 'MED',
      captionKo: '음성 활동이 감지되었습니다.',
      captionEn: 'Voice activity detected.',
      ruleBroken: 'AUDIO_HIGH',
      evidenceUrl,
      videoClipUrl,
      ts: body.ts,
    });

    return { eventId: event.id, videoClipUrl, evidenceUrl };
  }

  /** User-scoped evidence list — students see only their own session evidence. */
  async listEvidenceForUser(userId: string, sessionId: string) {
    const session = await this.prisma.examSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');
    if (session.userId !== userId) throw new ForbiddenException('Not your session');
    return this.formatEvidence(sessionId);
  }

  /** Admin-scoped evidence list — proctor / exam_admin only (RBAC enforced upstream). */
  async listEvidenceForAdmin(sessionId: string) {
    const session = await this.prisma.examSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');
    return this.formatEvidence(sessionId);
  }

  // ───────────────────── Demo evidence persistence ─────────────────────
  // Demo runs aren't bound to an ExamSession so we can't reuse
  // `proctoring_events` (FK to exam_sessions). Demo data lives in
  // `demo_proctoring_events`, scoped directly by userId. Same NCP bucket,
  // separate `demo/<userId>/` prefix.
  //
  // Graceful degradation: if the `demo_proctoring_events` table is missing
  // in the target environment (Prisma error code P2021), the JPEG/webm
  // upload still succeeds (file written to NCP / local fallback) — only
  // the row insert is skipped. The endpoint returns a soft response so
  // the demo runs without the silent UnhandledRejection that used to
  // happen. We log a single line per occurrence so this state is visible
  // in admin/ops dashboards.
  private demoTableMissingLogged = false;
  private isDemoTableMissingError(err: unknown): boolean {
    const e = err as { code?: string; message?: string };
    return (
      e?.code === 'P2021' ||
      (typeof e?.message === 'string' &&
        /demo_proctoring_events/.test(e.message) &&
        /does not exist/.test(e.message))
    );
  }
  private warnDemoTableMissingOnce(context: string): void {
    if (this.demoTableMissingLogged) return;
    this.demoTableMissingLogged = true;
    this.logger.warn(
      `[demo-evidence] ${context}: 'demo_proctoring_events' table is missing — file upload still succeeded but the audit row was not persisted. Apply prisma/migrations/manual-add-demo-proctoring-events.sql to enable demo evidence on MyPage.`,
    );
  }

  /** Persist a single demo-violation screenshot. */
  async recordDemoEvidence(
    userId: string,
    body: { ts: number; kind: string; imageBase64: string; severity?: string },
  ): Promise<{ id: string; evidenceUrl: string | null }> {
    const frame = decodeImage(body.imageBase64);
    const evidenceUrl = await this.uploadDemoFrame(userId, body.ts, frame);
    try {
      const event = await this.prisma.demoProctoringEvent.create({
        data: {
          userId,
          kind: body.kind,
          severity: body.severity ?? 'warning',
          captionKo: demoCaptionForKind(body.kind).ko,
          captionEn: demoCaptionForKind(body.kind).en,
          evidenceUrl,
          retainUntil: new Date(Date.now() + RETAIN_DEFAULT_DAYS * 86_400_000),
          metadata: { source: 'DEMO', ts: body.ts } as Prisma.InputJsonValue,
        },
      });
      return { id: event.id, evidenceUrl };
    } catch (err) {
      if (this.isDemoTableMissingError(err)) {
        this.warnDemoTableMissingOnce('recordDemoEvidence');
        return { id: 'unpersisted', evidenceUrl };
      }
      throw err;
    }
  }

  /** Persist a demo voice clip + optional still frame. */
  async recordDemoVoiceClip(
    userId: string,
    body: {
      ts: number;
      peakDb?: number;
      durationMs?: number;
      clipBuffer: Buffer;
      clipMime: string;
      stillFrame: Buffer | null;
    },
  ): Promise<{ id: string; videoClipUrl: string | null; evidenceUrl: string | null }> {
    const videoClipUrl = await this.uploadDemoAudioClip(
      userId,
      body.ts,
      body.clipBuffer,
      body.clipMime,
    );
    const evidenceUrl = body.stillFrame
      ? await this.uploadDemoFrame(userId, body.ts, body.stillFrame)
      : null;
    try {
      const event = await this.prisma.demoProctoringEvent.create({
        data: {
          userId,
          kind: 'AUDIO_HIGH',
          severity: 'MED',
          captionKo: '음성 활동이 감지되었습니다.',
          captionEn: 'Voice activity detected.',
          evidenceUrl,
          videoClipUrl,
          retainUntil: new Date(Date.now() + RETAIN_DEFAULT_DAYS * 86_400_000),
          metadata: {
            source: 'DEMO',
            ts: body.ts,
            peakDb: body.peakDb ?? null,
            durationMs: body.durationMs ?? null,
          } as Prisma.InputJsonValue,
        },
      });
      return { id: event.id, videoClipUrl, evidenceUrl };
    } catch (err) {
      if (this.isDemoTableMissingError(err)) {
        this.warnDemoTableMissingOnce('recordDemoVoiceClip');
        return { id: 'unpersisted', videoClipUrl, evidenceUrl };
      }
      throw err;
    }
  }

  /** Same shape as listEvidenceForUser, but from the demo table. */
  async listDemoEvidenceForUser(userId: string) {
    let events: Awaited<
      ReturnType<typeof this.prisma.demoProctoringEvent.findMany>
    > = [];
    try {
      events = await this.prisma.demoProctoringEvent.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
    } catch (err) {
      if (this.isDemoTableMissingError(err)) {
        this.warnDemoTableMissingOnce('listDemoEvidenceForUser');
        return [];
      }
      throw err;
    }
    return Promise.all(
      events.map(async (e) => ({
        id: e.id,
        type: e.kind,
        severity: e.severity,
        captionKo: e.captionKo,
        captionEn: e.captionEn,
        ruleBroken: null,
        confidence: null,
        createdAt: e.createdAt,
        retainUntil: e.retainUntil,
        evidenceUrl: e.evidenceUrl ? await this.signed(e.evidenceUrl) : null,
        videoClipUrl: e.videoClipUrl ? await this.signed(e.videoClipUrl) : null,
        screenEvidenceUrl: null,
      })),
    );
  }

  private async uploadDemoFrame(
    userId: string,
    ts: number,
    frame: Buffer,
  ): Promise<string | null> {
    const key = `demo/${userId}/evidence/${ts}-${randomUUID()}.jpg`;
    try {
      await this.ncp.put(this.ncp.bucketSnapshots(), key, frame, 'image/jpeg', RETAIN_DEFAULT_DAYS);
      return key;
    } catch (err) {
      this.logger.warn(`NCP put (demo frame) failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async uploadDemoAudioClip(
    userId: string,
    ts: number,
    clip: Buffer,
    mime: string,
  ): Promise<string | null> {
    const ext = mime.includes('webm') ? 'webm' : 'bin';
    const key = `demo/${userId}/audio/${ts}-${randomUUID()}.${ext}`;
    try {
      await this.ncp.put(
        this.ncp.bucketSnapshots(),
        key,
        clip,
        mime || 'application/octet-stream',
        RETAIN_DEFAULT_DAYS,
      );
      return key;
    } catch (err) {
      this.logger.warn(`NCP put (demo audio) failed: ${(err as Error).message}`);
      return null;
    }
  }

  // ─────────────────────────── helpers ───────────────────────────

  private effectiveSuspicionThreshold(flags: readonly string[]): number {
    if (flags.length === 0) return GEMINI_SUSPICION_THRESHOLD;
    let lowest = GEMINI_SUSPICION_THRESHOLD;
    for (const f of flags) {
      const override = PER_FLAG_THRESHOLDS.get(f);
      if (override !== undefined && override < lowest) lowest = override;
    }
    return lowest;
  }

  /**
   * Redis-offline fallback for phone-class flags. Persists a MED-severity
   * AI_FLAG_CONFIRMED row (Gemini-only — Claude could not be called), uploads
   * the frame as evidence, fires the admin alert, and increments the strike
   * counter via PHONE_DETECTED. Returns a MED verdict to the candidate.
   */
  private async handleRedisFallbackPhone(
    session: ExamSession,
    userId: string,
    geminiRes: GeminiScreenResult,
    ts: number,
    frame: Buffer,
    screenFrame: Buffer | null,
    dedupeKey: string,
  ): Promise<AiReviewResult> {
    const captionKo = '휴대전화로 의심되는 물체가 감지되었습니다.';
    const captionEn = 'A possible mobile phone has been detected.';
    const ruleBroken = geminiRes.flags[0] ?? 'PHONE_IN_FRAME';
    const evidenceUrl = await this.uploadEvidenceFrame(session, ts, frame);
    const screenEvidenceUrl = screenFrame
      ? await this.uploadScreenEvidenceFrame(session, ts, screenFrame)
      : null;
    const retainUntil = await this.computeRetainUntil(session);
    const event = await this.prisma.proctoringEvent.create({
      data: {
        sessionId: session.id,
        eventType: ProctorEventType.AI_FLAG_CONFIRMED,
        severity: 'MED' as AiSeverity,
        captionKo,
        captionEn,
        evidenceUrl,
        retainUntil,
        metadata: {
          source: 'SERVER',
          aiTier: 'GEMINI' as AiTier,
          aiRuleBroken: ruleBroken,
          aiConfidence: geminiRes.confidence,
          dedupeKey,
          screenEvidenceUrl,
          fallbackReason: 'redis-unavailable+phone-class',
          tier1: {
            confidence: geminiRes.confidence,
            flags: geminiRes.flags,
            modelMs: geminiRes.modelMs,
            inputTokens: geminiRes.inputTokens,
            outputTokens: geminiRes.outputTokens,
          },
        } as Prisma.InputJsonValue,
      },
    });

    await this.publishAlert({
      sessionId: session.id,
      userId,
      eventId: event.id,
      type: 'AI_FLAG_CONFIRMED',
      severity: 'MED',
      captionKo,
      captionEn,
      ruleBroken,
      evidenceUrl,
      videoClipUrl: null,
      ts,
    });

    try {
      await this.cbtSessions.recordSystemProctorEvent(
        session.id,
        ProctorEventType.PHONE_DETECTED,
        {
          origin: 'AI_FALLBACK_REDIS_OFFLINE',
          aiEventId: event.id,
          flags: geminiRes.flags,
          ts,
        },
      );
    } catch (err) {
      this.logger.warn(
        `PHONE_DETECTED strike write failed (fallback path): ${(err as Error).message}`,
      );
    }

    return {
      aiVerdict: 'MED',
      captionKo,
      captionEn,
      ruleBroken,
      evidenceUrl,
      degraded: false,
      escalated: false,
      duplicate: false,
    };
  }

  /**
   * Claude-offline fallback. Mirrors `handleRedisFallbackPhone` but is keyed
   * on the Tier-2 service being configured-absent rather than Redis being
   * down. Decision matrix:
   *
   *   phone-class flag, conf >= 0.6 → AI_FLAG_CONFIRMED MED + PHONE_DETECTED strike
   *   gaze-class  flag, conf >= 0.5 → AI_FLAG_CONFIRMED MED + GAZE_AWAY strike
   *   non-phone non-gaze, conf >= 0.7 → AI_FLAG_CONFIRMED LOW (no strike)
   *   below the relevant bar         → AI_FLAG_SUSPICIOUS only (logged, no strike)
   *
   * Severity is capped at MED — we never escalate to HIGH without an
   * independent verifier. Phone and gaze share the MED tier because both
   * fire a strike that counts toward 3-strike termination. The metadata
   * records `tier: 'GEMINI'` and `fallbackReason: 'claude-not-configured'`
   * so admins can audit.
   */
  private async handleClaudeOfflineFallback(
    session: ExamSession,
    userId: string,
    geminiRes: GeminiScreenResult,
    ts: number,
    frame: Buffer,
    screenFrame: Buffer | null,
    dedupeKey: string,
  ): Promise<AiReviewResult> {
    const phoneOnly =
      geminiRes.flags.length > 0 &&
      geminiRes.flags.every((f) => PHONE_CLASS_FLAGS.has(f));
    const phoneAny = geminiRes.flags.some((f) => PHONE_CLASS_FLAGS.has(f));
    const gazeAny = geminiRes.flags.some((f) => GAZE_CLASS_FLAGS.has(f));
    const meetsPhoneBar =
      phoneAny && geminiRes.confidence >= GEMINI_ONLY_PHONE_CONFIDENCE;
    const meetsGazeBar =
      gazeAny && !phoneAny && geminiRes.confidence >= GEMINI_ONLY_GAZE_CONFIDENCE;
    const meetsOtherBar =
      !phoneAny && !gazeAny && geminiRes.confidence >= GEMINI_ONLY_OTHER_CONFIDENCE;

    if (!meetsPhoneBar && !meetsGazeBar && !meetsOtherBar) {
      // Below the precision bar — log as SUSPICIOUS (no strike, no banner)
      // so admins can still see Gemini saw something, but the candidate is
      // not penalized.
      const eventId = await this.persistSuspiciousOnly(
        session,
        geminiRes,
        ts,
        dedupeKey,
      );
      await this.publishAlert({
        sessionId: session.id,
        userId,
        eventId,
        type: 'AI_FLAG_SUSPICIOUS',
        severity: 'LOW',
        captionKo: this.geminiHintKo(geminiRes),
        captionEn: this.geminiHintEn(geminiRes),
        ruleBroken: null,
        evidenceUrl: null,
        videoClipUrl: null,
        ts,
      });
      return {
        aiVerdict: 'OK',
        captionKo: null,
        captionEn: null,
        ruleBroken: null,
        evidenceUrl: null,
        degraded: false,
        escalated: false,
        duplicate: false,
      };
    }

    // Above the bar — confirm + write evidence.
    // Phone and gaze both rate MED (both fire a strike). Other suspicious
    // flags rate LOW (logged but no strike) since they don't have a
    // dedicated termination path.
    const severity: AiSeverity = meetsPhoneBar || meetsGazeBar ? 'MED' : 'LOW';
    const ruleBroken =
      geminiRes.flags[0] ??
      (meetsPhoneBar
        ? 'PHONE_IN_FRAME'
        : meetsGazeBar
          ? 'LOOKING_OFF_SCREEN'
          : 'OTHER_SUSPICIOUS');
    const captionKo = meetsPhoneBar
      ? '휴대전화로 의심되는 물체가 감지되었습니다.'
      : meetsGazeBar
        ? '시선이 화면을 벗어났습니다.'
        : `의심 정황이 감지되었습니다 (${geminiRes.flags.slice(0, 2).join(', ')}).`.slice(0, 120);
    const captionEn = meetsPhoneBar
      ? 'A possible mobile phone has been detected.'
      : meetsGazeBar
        ? 'Eyes off the screen.'
        : `Suspicious activity detected (${geminiRes.flags.slice(0, 2).join(', ')}).`.slice(0, 120);

    const evidenceUrl = await this.uploadEvidenceFrame(session, ts, frame);
    const screenEvidenceUrl = screenFrame
      ? await this.uploadScreenEvidenceFrame(session, ts, screenFrame)
      : null;
    const retainUntil = await this.computeRetainUntil(session);
    const event = await this.prisma.proctoringEvent.create({
      data: {
        sessionId: session.id,
        eventType: ProctorEventType.AI_FLAG_CONFIRMED,
        severity,
        captionKo,
        captionEn,
        evidenceUrl,
        retainUntil,
        metadata: {
          source: 'SERVER',
          aiTier: 'GEMINI' as AiTier,
          aiRuleBroken: ruleBroken,
          aiConfidence: geminiRes.confidence,
          dedupeKey,
          screenEvidenceUrl,
          fallbackReason: 'claude-not-configured',
          phoneOnly,
          tier1: {
            confidence: geminiRes.confidence,
            flags: geminiRes.flags,
            notes: geminiRes.notes,
            modelMs: geminiRes.modelMs,
            inputTokens: geminiRes.inputTokens,
            outputTokens: geminiRes.outputTokens,
          },
        } as Prisma.InputJsonValue,
      },
    });

    await this.publishAlert({
      sessionId: session.id,
      userId,
      eventId: event.id,
      type: 'AI_FLAG_CONFIRMED',
      severity,
      captionKo,
      captionEn,
      ruleBroken,
      evidenceUrl,
      videoClipUrl: null,
      ts,
    });

    if (meetsPhoneBar) {
      try {
        await this.cbtSessions.recordSystemProctorEvent(
          session.id,
          ProctorEventType.PHONE_DETECTED,
          {
            origin: 'AI_FALLBACK_CLAUDE_OFFLINE',
            aiEventId: event.id,
            flags: geminiRes.flags,
            confidence: geminiRes.confidence,
            ts,
          },
        );
      } catch (err) {
        this.logger.warn(
          `PHONE_DETECTED strike write failed (claude-offline path): ${(err as Error).message}`,
        );
      }
    }

    if (meetsGazeBar) {
      try {
        await this.cbtSessions.recordSystemProctorEvent(
          session.id,
          ProctorEventType.GAZE_AWAY,
          {
            origin: 'AI_FALLBACK_CLAUDE_OFFLINE',
            aiEventId: event.id,
            flags: geminiRes.flags,
            confidence: geminiRes.confidence,
            ts,
          },
        );
      } catch (err) {
        this.logger.warn(
          `GAZE_AWAY strike write failed (claude-offline path): ${(err as Error).message}`,
        );
      }
    }

    return {
      aiVerdict: severity,
      captionKo,
      captionEn,
      ruleBroken,
      evidenceUrl,
      degraded: false,
      escalated: false,
      duplicate: false,
    };
  }

  /**
   * Demo-only AI review: runs Gemini tier-1 screening only, no session
   * validation, no evidence persistence, no Claude tier-2. Returns a
   * simplified verdict for the demo warning system.
   */
  async demoReview(
    imageBase64: string,
    ts: number,
  ): Promise<AiReviewResult> {
    const frame = decodeImage(imageBase64);
    const ctx = {
      sessionId: 'demo',
      userId: 'demo',
      certType: 'AXIS',
      level: 'L3',
      ts,
    };
    const geminiRes = await this.gemini.screen(frame, ctx);
    if (geminiRes.degraded) {
      return this.degradedResult();
    }
    const effectiveThreshold = this.effectiveSuspicionThreshold(geminiRes.flags);
    if (!geminiRes.suspicious || geminiRes.confidence < effectiveThreshold) {
      return this.okResult();
    }
    const severity = demoFlagSeverity(geminiRes.flags);
    const caption = demoCaptionFromFlags(geminiRes.flags);
    return {
      aiVerdict: severity,
      captionKo: caption.ko,
      captionEn: caption.en,
      ruleBroken: geminiRes.flags.join(', '),
      evidenceUrl: null,
      degraded: false,
      escalated: false,
      duplicate: false,
    };
  }

  private async requireOwnedInProgress(
    userId: string,
    sessionId: string,
  ): Promise<ExamSession> {
    const session = await this.prisma.examSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');
    if (session.userId !== userId) throw new ForbiddenException('Not your session');
    if (session.status !== ExamSessionStatus.IN_PROGRESS) {
      throw new ConflictException(`Session is ${session.status}, not IN_PROGRESS`);
    }
    return session;
  }

  /**
   * Voice-clip uploads have a tight race with `terminateForVoiceStrikes`
   * (and `terminateForMicDisconnect`): on the threshold strike the client
   * fires the JSON termination POST and the multipart clip upload in
   * parallel, and the tiny JSON request usually returns first — flipping
   * the session row to TERMINATED. By the time the (slower) multipart
   * clip lands, `requireOwnedInProgress` would reject with 409, silently
   * dropping the only proof that justifies the termination from the
   * admin's EvidenceModal timeline.
   *
   * This gate accepts an IN_PROGRESS session normally, and also permits
   * the SAME owner to write evidence for up to `VOICE_CLIP_GRACE_MS`
   * after a TERMINATED session's `submittedAt`. That window is well
   * beyond any reasonable in-flight retry/network delay (multipart
   * 10s-clip uploads typically complete in <2s) but tight enough that
   * post-hoc clip injection isn't feasible. Outside the grace window,
   * or for any other terminal status (SUBMITTED / GRADED / EXPIRED),
   * we still reject — those sessions are out of the proctor pipeline
   * and shouldn't be accruing new evidence rows.
   */
  private async requireOwnedActiveOrRecentlyTerminated(
    userId: string,
    sessionId: string,
  ): Promise<ExamSession> {
    const VOICE_CLIP_GRACE_MS = 5 * 60_000;
    const session = await this.prisma.examSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');
    if (session.userId !== userId) throw new ForbiddenException('Not your session');
    if (session.status === ExamSessionStatus.IN_PROGRESS) return session;
    if (
      session.status === ExamSessionStatus.TERMINATED &&
      session.submittedAt &&
      Date.now() - session.submittedAt.getTime() <= VOICE_CLIP_GRACE_MS
    ) {
      return session;
    }
    throw new ConflictException(`Session is ${session.status}, not IN_PROGRESS`);
  }

  /** Atomic SET NX EX gate. Returns true iff this caller acquired the slot. */
  private async acquireClaudeSlot(sessionId: string): Promise<boolean> {
    if (!this.redis.isReady()) {
      // Fail-closed when Redis is down — without a cost gate we'd hammer Claude.
      this.logger.warn('Redis offline — skipping Claude escalation to protect cost cap.');
      return false;
    }
    return this.redis.setNxEx(
      `proctor:claude:rl:${sessionId}`,
      CLAUDE_RL_TTL_SEC,
    );
  }

  private async persistSuspiciousOnly(
    session: ExamSession,
    geminiRes: GeminiScreenResult,
    ts: number,
    dedupeKey: string,
  ): Promise<string> {
    const retainUntil = await this.computeRetainUntil(session);
    // Soft idempotency — there's no UNIQUE(sessionId, dedupeKey) constraint
    // because dedupeKey lives inside `metadata` JSON. If a row with the same
    // dedupeKey already exists (rare — Redis SET NX usually catches it first),
    // return the existing id instead of inserting a duplicate.
    const existing = await this.findByDedupeKey(session.id, dedupeKey);
    if (existing) return existing.id;
    const ev = await this.prisma.proctoringEvent.create({
      data: {
        sessionId: session.id,
        eventType: ProctorEventType.AI_FLAG_SUSPICIOUS,
        severity: 'LOW' as AiSeverity,
        captionKo: this.geminiHintKo(geminiRes),
        captionEn: this.geminiHintEn(geminiRes),
        retainUntil,
        metadata: {
          source: 'SERVER',
          aiTier: 'GEMINI' as AiTier,
          aiRuleBroken: geminiRes.flags[0] ?? null,
          aiConfidence: geminiRes.confidence,
          dedupeKey,
          tier1: {
            confidence: geminiRes.confidence,
            flags: geminiRes.flags,
            notes: geminiRes.notes,
            modelMs: geminiRes.modelMs,
            inputTokens: geminiRes.inputTokens,
            outputTokens: geminiRes.outputTokens,
          },
        } as Prisma.InputJsonValue,
      },
    });
    return ev.id;
  }

  /**
   * Find a ProctoringEvent by its `metadata.dedupeKey`. Used for soft
   * idempotency in the AI/audio paths. Reads only `id, evidenceUrl,
   * videoClipUrl` because callers don't need the full row.
   */
  private async findByDedupeKey(
    sessionId: string,
    dedupeKey: string,
  ): Promise<{ id: string; evidenceUrl: string | null; videoClipUrl: string | null } | null> {
    const row = await this.prisma.proctoringEvent.findFirst({
      where: {
        sessionId,
        metadata: { path: '$.dedupeKey', equals: dedupeKey } as Prisma.JsonFilter,
      },
      select: { id: true, evidenceUrl: true, videoClipUrl: true },
    });
    return row;
  }

  private async uploadEvidenceFrame(
    session: ExamSession,
    ts: number,
    frame: Buffer,
  ): Promise<string | null> {
    const key = `proctor/${session.id}/evidence/${ts}-${randomUUID()}.jpg`;
    try {
      await this.ncp.put(this.ncp.bucketSnapshots(), key, frame, 'image/jpeg', RETAIN_DEFAULT_DAYS);
      return key;
    } catch (err) {
      this.logger.warn(`NCP put (frame) failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Upload the candidate's screen-share frame as supplementary evidence on a
   * confirmed cheating verdict. Stored under a separate `screen-evidence/`
   * prefix so admins/auditors can distinguish webcam vs screen at a glance,
   * and so retention sweeps can target them independently if ever needed.
   * Best-effort: a NCP failure logs and returns `null`, never blocking the
   * webcam evidence write or the candidate response.
   */
  private async uploadScreenEvidenceFrame(
    session: ExamSession,
    ts: number,
    frame: Buffer,
  ): Promise<string | null> {
    const key = `proctor/${session.id}/screen-evidence/${ts}-${randomUUID()}.jpg`;
    try {
      await this.ncp.put(this.ncp.bucketSnapshots(), key, frame, 'image/jpeg', RETAIN_DEFAULT_DAYS);
      return key;
    } catch (err) {
      this.logger.warn(`NCP put (screen frame) failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async uploadAudioClip(
    session: ExamSession,
    ts: number,
    clip: Buffer,
    mime: string,
  ): Promise<string | null> {
    const ext = mime.includes('webm') ? 'webm' : 'bin';
    const key = `proctor/${session.id}/audio/${ts}-${randomUUID()}.${ext}`;
    try {
      await this.ncp.put(
        this.ncp.bucketSnapshots(),
        key,
        clip,
        mime || 'application/octet-stream',
        RETAIN_DEFAULT_DAYS,
      );
      return key;
    } catch (err) {
      this.logger.warn(`NCP put (audio) failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Default 90 days. If a UserPenalty is already ACTIVE and tied to this
   * session, bump to 2 years up front so we don't lose evidence between the
   * insert and the next snapshot-processor pass.
   */
  private async computeRetainUntil(session: ExamSession): Promise<Date> {
    const now = Date.now();
    const activePenalty = await this.prisma.userPenalty.findFirst({
      where: {
        userId: session.userId,
        sessionId: session.id,
        status: PenaltyStatus.ACTIVE,
      },
    });
    const days = activePenalty ? RETAIN_PENALTY_DAYS : RETAIN_DEFAULT_DAYS;
    return new Date(now + days * 86_400_000);
  }

  private async publishAlert(
    payload: Parameters<AdminGateway['emitAiAlert']>[0],
  ): Promise<void> {
    try {
      await this.adminGateway.emitAiAlert(payload);
    } catch (err) {
      this.logger.warn(`emitAiAlert failed: ${(err as Error).message}`);
    }
  }

  private async formatEvidence(sessionId: string) {
    // Surface every event type that *can* carry a webcam/screen snapshot:
    // the AI tier-1/tier-2 verdicts, voice spikes, the client-side webcam
    // heuristics enriched in CbtSessionsService.attachCachedFramesToEvent
    // (GAZE_AWAY, NO_FACE, EYES_CLOSED, MULTIPLE_FACES, IDENTITY_MISMATCH,
    //  FACE_NOT_DETECTED, PHONE_DETECTED), AND the page-leave class
    // (FULLSCREEN_EXIT, TAB_SWITCH, WINDOW_BLUR, TAB_HIDDEN, BEFORE_UNLOAD)
    // which gets the same Redis-cached webcam + screen frames attached so
    // admins can see what the candidate was physically doing and what was
    // on their screen the moment they left the exam window. Events without
    // an evidenceUrl still appear in the timeline — the admin modal renders
    // a "(no snapshot)" hint so the absence is unambiguous (e.g. when the
    // page-leave fired before any frame had been cached in Redis yet).
    const events = await this.prisma.proctoringEvent.findMany({
      where: {
        sessionId,
        OR: [
          {
            eventType: {
              in: [
                ProctorEventType.AI_FLAG_SUSPICIOUS,
                ProctorEventType.AI_FLAG_CONFIRMED,
                ProctorEventType.AUDIO_HIGH,
                ProctorEventType.GAZE_AWAY,
                ProctorEventType.NO_FACE,
                ProctorEventType.EYES_CLOSED,
                ProctorEventType.MULTIPLE_FACES,
                ProctorEventType.IDENTITY_MISMATCH,
                ProctorEventType.FACE_NOT_DETECTED,
                ProctorEventType.PHONE_DETECTED,
                // External-display + page-leave class now carry a client-captured
                // snapshot taken at the moment of the violation.
                ProctorEventType.EXTERNAL_DISPLAY,
                ProctorEventType.FULLSCREEN_EXIT,
                ProctorEventType.TAB_SWITCH,
                ProctorEventType.WINDOW_BLUR,
                ProctorEventType.TAB_HIDDEN,
                ProctorEventType.BEFORE_UNLOAD,
              ],
            },
          },
          // Any event that actually has a stored frame/clip, regardless of type
          // (covers capture-on-violation for event types not listed above).
          { evidenceUrl: { not: null } },
          { videoClipUrl: { not: null } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(
      events.map(async (e) => {
        const meta = (e.metadata ?? {}) as Record<string, unknown>;
        const screenKey = typeof meta.screenEvidenceUrl === 'string' ? meta.screenEvidenceUrl : null;
        return {
          id: e.id,
          type: e.eventType,
          severity: e.severity,
          captionKo: e.captionKo,
          captionEn: e.captionEn,
          ruleBroken: typeof meta.aiRuleBroken === 'string' ? meta.aiRuleBroken : null,
          confidence: typeof meta.aiConfidence === 'number' ? meta.aiConfidence : null,
          createdAt: e.createdAt,
          retainUntil: e.retainUntil,
          evidenceUrl: e.evidenceUrl ? await this.signed(e.evidenceUrl) : null,
          videoClipUrl: e.videoClipUrl ? await this.signed(e.videoClipUrl) : null,
          screenEvidenceUrl: screenKey ? await this.signed(screenKey) : null,
        };
      }),
    );
  }

  private async signed(key: string): Promise<string | null> {
    try {
      return await this.ncp.signedGetUrl(key, SIGNED_URL_TTL_SEC);
    } catch (err) {
      this.logger.warn(`signedGetUrl failed for ${key}: ${(err as Error).message}`);
      return null;
    }
  }

  private geminiHintKo(g: GeminiScreenResult): string {
    if (g.flags.length === 0) return '의심 정황이 감지되었습니다.';
    return `의심 정황이 감지되었습니다 (${g.flags.slice(0, 2).join(', ')}).`.slice(0, 120);
  }

  private geminiHintEn(g: GeminiScreenResult): string {
    if (g.flags.length === 0) return 'Suspicious activity detected.';
    return `Suspicious activity detected (${g.flags.slice(0, 2).join(', ')}).`.slice(0, 120);
  }

  private okResult(): AiReviewResult {
    return {
      aiVerdict: 'OK',
      captionKo: null,
      captionEn: null,
      ruleBroken: null,
      evidenceUrl: null,
      degraded: false,
      escalated: false,
      duplicate: false,
    };
  }

  private degradedResult(): AiReviewResult {
    return {
      aiVerdict: 'OK',
      captionKo: null,
      captionEn: null,
      ruleBroken: null,
      evidenceUrl: null,
      degraded: true,
      escalated: false,
      duplicate: false,
    };
  }

  private duplicateResult(): AiReviewResult {
    return {
      aiVerdict: 'OK',
      captionKo: null,
      captionEn: null,
      ruleBroken: null,
      evidenceUrl: null,
      degraded: false,
      escalated: false,
      duplicate: true,
    };
  }
}

function decodeImage(s: string): Buffer {
  const stripped = s.replace(/^data:image\/[a-z]+;base64,/, '');
  if (!stripped) throw new BadRequestException('Empty image');
  const buf = Buffer.from(stripped, 'base64');
  if (buf.length === 0) throw new BadRequestException('Invalid base64 image');
  if (buf.length > 4 * 1024 * 1024) {
    throw new BadRequestException('Image too large (max 4MB)');
  }
  return buf;
}

/**
 * Gemini-flag → severity mapping for the demo path (no Claude tier-2).
 * Phone/device flags → MED, gaze → LOW, others → LOW.
 */
function demoFlagSeverity(flags: string[]): 'LOW' | 'MED' | 'HIGH' {
  const hasPhone = flags.some((f) => PHONE_CLASS_FLAGS.has(f));
  if (hasPhone) return 'MED';
  return 'LOW';
}

/**
 * Human-readable caption from Gemini flags (demo path).
 */
function demoCaptionFromFlags(flags: string[]): { ko: string; en: string } {
  const labels: Record<string, { ko: string; en: string }> = {
    PHONE_IN_FRAME: { ko: '휴대폰이 감지되었습니다', en: 'Phone detected in frame' },
    OTHER_DEVICE_IN_FRAME: { ko: '기타 기기가 감지되었습니다', en: 'Other device detected' },
    HEADPHONES_OR_EARBUDS: { ko: '이어폰/헤드폰 착용이 감지되었습니다', en: 'Headphones or earbuds detected' },
    SMART_GLASSES: { ko: '스마트 안경이 감지되었습니다', en: 'Smart glasses detected' },
    EARPIECE: { ko: '이어피스가 감지되었습니다', en: 'Earpiece detected' },
    HAT_OR_HOOD: { ko: '모자/후드 착용이 감지되었습니다', en: 'Hat or hood detected' },
    MASK_COVERING_FACE: { ko: '얼굴 가림이 감지되었습니다', en: 'Face mask detected' },
    SECOND_PERSON_IN_FRAME: { ko: '제2인이 감지되었습니다', en: 'Second person detected' },
    LOOKING_OFF_SCREEN: { ko: '시선이 화면 밖을 향하고 있습니다', en: 'Looking off screen' },
    HANDS_NEAR_EARS: { ko: '귀 근처에 손이 감지되었습니다', en: 'Hands near ears detected' },
    PAPER_OR_BOOK: { ko: '종이/책이 감지되었습니다', en: 'Paper or book detected' },
    WRITING_ON_HAND: { ko: '손에 필기가 감지되었습니다', en: 'Writing on hand detected' },
    OTHER_SUSPICIOUS: { ko: '의심스러운 행동이 감지되었습니다', en: 'Suspicious behavior detected' },
  };
  const first = flags[0];
  if (first && labels[first]) return labels[first];
  return { ko: '의심스러운 행동이 감지되었습니다', en: 'Suspicious behavior detected' };
}

/**
 * Caption map for the demo evidence path. DemoPage records violations by
 * client-side kind (LOOK_AWAY, NO_FACE, VOICE, PAGE_LEAVE, etc.) — we just
 * surface a short label for each so the MyPage demo timeline reads cleanly.
 * Unknown kinds fall back to the generic "Demo violation" caption.
 */
export function demoCaptionForKind(kind: string): { ko: string; en: string } {
  const map: Record<string, { ko: string; en: string }> = {
    LOOK_AWAY: { ko: '시선이 화면을 벗어났습니다', en: 'Looked away from screen' },
    NO_FACE: { ko: '얼굴이 감지되지 않았습니다', en: 'No face detected' },
    EYES_CLOSED: { ko: '눈을 감은 상태가 감지되었습니다', en: 'Eyes closed' },
    VOICE: { ko: '음성 활동이 감지되었습니다', en: 'Voice activity detected' },
    PAGE_LEAVE: { ko: '시험 화면을 벗어났습니다', en: 'Left the exam window' },
    MULTIPLE_FACES: { ko: '여러 얼굴이 감지되었습니다', en: 'Multiple faces detected' },
    IDENTITY_MISMATCH: { ko: '본인 확인에 실패했습니다', en: 'Identity mismatch' },
    DUPLICATE_TAB: { ko: '중복 탭이 감지되었습니다', en: 'Duplicate tab detected' },
    AI_FLAG_SUSPICIOUS: { ko: 'AI 의심 정황이 감지되었습니다', en: 'AI flagged as suspicious' },
    AI_FLAG_CONFIRMED: { ko: 'AI 위반이 확인되었습니다', en: 'AI confirmed violation' },
    AUDIO_HIGH: { ko: '음성 활동이 감지되었습니다', en: 'Voice activity detected' },
    PHONE_DETECTED: { ko: '휴대폰이 감지되었습니다', en: 'Phone detected' },
    PHONE_IN_FRAME: { ko: '휴대폰이 감지되었습니다', en: 'Phone detected in frame' },
    OTHER_DEVICE_IN_FRAME: { ko: '금지 기기가 감지되었습니다', en: 'Prohibited device detected' },
  };
  return map[kind] ?? { ko: '데모 위반이 기록되었습니다', en: 'Demo violation recorded' };
}

import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  ExamSessionStatus,
  PenaltyStatus,
  ProctorEventType,
} from '@prisma/client';
import { AiProctorService } from './ai-proctor.service';
import type { GeminiVisionService } from '../../integrations/googleGemini/google-gemini.service';
import type { ClaudeProctorService } from '../../integrations/anthropic/claude-proctor.service';
import type { NcObjectStorageService } from '../../integrations/ncObjectStorage/nc-object-storage.service';
import type { RedisService } from '../../integrations/redis/redis.service';
import type { AdminGateway } from '../../websocket/admin.gateway';
import type { PrismaService } from '../../common/prisma.service';
import type { CbtSessionsService } from '../cbtSessions/cbt-sessions.service';

type Mock<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? jest.Mock<R, A>
    : T[K];
};

const FRAME_B64 = Buffer.from('test-jpeg-bytes').toString('base64');
const SESSION_ID = 'sess-1';
const USER_ID = 'user-1';

function makeSession(overrides: Partial<{
  id: string;
  userId: string;
  status: ExamSessionStatus;
  certType: 'AXIS' | 'AXIS_C' | 'AXIS_H';
  level: 'L1' | 'L2' | 'L3';
}> = {}) {
  return {
    id: overrides.id ?? SESSION_ID,
    userId: overrides.userId ?? USER_ID,
    status: overrides.status ?? ExamSessionStatus.IN_PROGRESS,
    certType: overrides.certType ?? 'AXIS',
    level: overrides.level ?? 'L3',
    proctorWarnings: 0,
  };
}

function makeMocks() {
  const prisma = {
    examSession: { findUnique: jest.fn() },
    proctoringEvent: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    userPenalty: { findFirst: jest.fn() },
  } as unknown as Mock<PrismaService>;

  const gemini = { isConfigured: jest.fn(() => true), screen: jest.fn() } as unknown as Mock<GeminiVisionService>;
  const claude = { isConfigured: jest.fn(() => true), verifyAndCaption: jest.fn() } as unknown as Mock<ClaudeProctorService>;
  const ncp = {
    isConfigured: jest.fn(() => true),
    bucketSnapshots: jest.fn(() => 'axis-snapshots'),
    put: jest.fn(async () => ({ key: 'k', bucket: 'axis-snapshots', bytes: 1 })),
    signedGetUrl: jest.fn(async () => 'https://signed/url'),
  } as unknown as Mock<NcObjectStorageService>;
  const redis = {
    isReady: jest.fn(() => true),
    setNxEx: jest.fn(async () => true),
    publish: jest.fn(async () => undefined),
    subscribe: jest.fn(async () => undefined),
  } as unknown as Mock<RedisService>;
  const adminGateway = { emitAiAlert: jest.fn(async () => undefined) } as unknown as Mock<AdminGateway>;
  const heartbeat = {
    markAlive: jest.fn(async () => undefined),
    getLastSeen: jest.fn(async () => null),
    getLastSeenMany: jest.fn(async () => new Map<string, number>()),
    clear: jest.fn(async () => undefined),
  } as unknown as Mock<{ markAlive: (id: string) => Promise<void> }>;
  const cbtSessions = {
    recordSystemProctorEvent: jest.fn(async () => ({ type: 'PHONE_DETECTED' })),
  } as unknown as Mock<CbtSessionsService>;

  return { prisma, gemini, claude, ncp, redis, adminGateway, heartbeat, cbtSessions };
}

function makeService(m: ReturnType<typeof makeMocks>): AiProctorService {
  return new AiProctorService(
    m.prisma as unknown as PrismaService,
    m.gemini as unknown as GeminiVisionService,
    m.claude as unknown as ClaudeProctorService,
    m.ncp as unknown as NcObjectStorageService,
    m.redis as unknown as RedisService,
    m.adminGateway as unknown as AdminGateway,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    m.heartbeat as any,
    m.cbtSessions as unknown as CbtSessionsService,
  );
}

describe('AiProctorService.review — cost guard', () => {
  it('100 consecutive flags within 30s → Claude is called at most once per session', async () => {
    const m = makeMocks();
    (m.prisma.examSession.findUnique as jest.Mock).mockResolvedValue(makeSession());
    (m.prisma.userPenalty.findFirst as jest.Mock).mockResolvedValue(null);
    (m.prisma.proctoringEvent.create as jest.Mock).mockImplementation(
      async ({ data }) => ({ id: 'ev-' + Math.random(), ...data }),
    );

    // First setNxEx(claude slot) → true; subsequent → false (within TTL).
    let claudeAcquireCount = 0;
    let dedupeCount = 0;
    (m.redis.setNxEx as jest.Mock).mockImplementation(async (key: string) => {
      if (key.startsWith('proctor:ai:dedupe:')) {
        dedupeCount += 1;
        return true; // every ts is unique in this test
      }
      if (key.startsWith('proctor:claude:rl:')) {
        claudeAcquireCount += 1;
        return claudeAcquireCount === 1; // only first call wins the slot
      }
      return false;
    });

    (m.gemini.screen as jest.Mock).mockResolvedValue({
      suspicious: true,
      confidence: 0.9,
      flags: ['PHONE_IN_FRAME'],
      notes: '',
      modelMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      degraded: false,
    });
    (m.claude.verifyAndCaption as jest.Mock).mockResolvedValue({
      confirmed: true,
      severity: 'MED',
      ruleBroken: 'PHONE_IN_FRAME',
      captionKo: '휴대전화가 보입니다.',
      captionEn: 'A phone is visible.',
      modelMs: 200,
      degraded: false,
    });

    const svc = makeService(m);
    for (let i = 0; i < 100; i++) {
      await svc.review(USER_ID, {
        sessionId: SESSION_ID,
        ts: Date.now() + i,
        imageBase64: FRAME_B64,
      });
    }

    expect((m.claude.verifyAndCaption as jest.Mock).mock.calls.length).toBe(1);
    expect(dedupeCount).toBe(100);
    expect(claudeAcquireCount).toBe(100); // attempted on every flag, won only once
  });
});

describe('AiProctorService.review — degraded mode', () => {
  it('returns OK when Gemini is degraded; never calls Claude or NCP', async () => {
    const m = makeMocks();
    (m.prisma.examSession.findUnique as jest.Mock).mockResolvedValue(makeSession());
    (m.gemini.screen as jest.Mock).mockResolvedValue({
      suspicious: false,
      confidence: 0,
      flags: [],
      notes: 'offline',
      modelMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      degraded: true,
    });

    const svc = makeService(m);
    const res = await svc.review(USER_ID, {
      sessionId: SESSION_ID,
      ts: 1,
      imageBase64: FRAME_B64,
    });

    expect(res.aiVerdict).toBe('OK');
    expect(res.degraded).toBe(true);
    expect((m.claude.verifyAndCaption as jest.Mock).mock.calls.length).toBe(0);
    expect((m.ncp.put as jest.Mock).mock.calls.length).toBe(0);
  });

  it('returns OK when Gemini suspicious but Claude is degraded; no NCP upload', async () => {
    const m = makeMocks();
    (m.prisma.examSession.findUnique as jest.Mock).mockResolvedValue(makeSession());
    (m.gemini.screen as jest.Mock).mockResolvedValue({
      suspicious: true,
      confidence: 0.9,
      flags: ['PHONE_IN_FRAME'],
      notes: '',
      modelMs: 100,
      inputTokens: 0,
      outputTokens: 0,
      degraded: false,
    });
    (m.claude.verifyAndCaption as jest.Mock).mockResolvedValue({
      confirmed: false,
      severity: 'LOW',
      ruleBroken: '',
      captionKo: '',
      captionEn: '',
      modelMs: 0,
      degraded: true,
    });

    const svc = makeService(m);
    const res = await svc.review(USER_ID, {
      sessionId: SESSION_ID,
      ts: 2,
      imageBase64: FRAME_B64,
    });

    expect(res.aiVerdict).toBe('OK');
    expect(res.degraded).toBe(true);
    expect((m.ncp.put as jest.Mock).mock.calls.length).toBe(0);
  });

  it('rejects when session is not IN_PROGRESS', async () => {
    const m = makeMocks();
    (m.prisma.examSession.findUnique as jest.Mock).mockResolvedValue(
      makeSession({ status: ExamSessionStatus.SUBMITTED }),
    );
    const svc = makeService(m);
    await expect(
      svc.review(USER_ID, { sessionId: SESSION_ID, ts: 3, imageBase64: FRAME_B64 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects when session belongs to another user', async () => {
    const m = makeMocks();
    (m.prisma.examSession.findUnique as jest.Mock).mockResolvedValue(
      makeSession({ userId: 'someone-else' }),
    );
    const svc = makeService(m);
    await expect(
      svc.review(USER_ID, { sessionId: SESSION_ID, ts: 4, imageBase64: FRAME_B64 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('AiProctorService.review — retainUntil calculation', () => {
  it('default retainUntil is +90 days when no active penalty', async () => {
    const m = makeMocks();
    (m.prisma.examSession.findUnique as jest.Mock).mockResolvedValue(makeSession());
    (m.prisma.userPenalty.findFirst as jest.Mock).mockResolvedValue(null);
    (m.gemini.screen as jest.Mock).mockResolvedValue({
      suspicious: true,
      confidence: 0.9,
      flags: ['PHONE_IN_FRAME'],
      notes: '',
      modelMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      degraded: false,
    });
    (m.claude.verifyAndCaption as jest.Mock).mockResolvedValue({
      confirmed: true,
      severity: 'MED',
      ruleBroken: 'PHONE_IN_FRAME',
      captionKo: '휴대전화가 보입니다.',
      captionEn: 'A phone is visible.',
      modelMs: 1,
      degraded: false,
    });
    const captured: { retainUntil: Date | null } = { retainUntil: null };
    (m.prisma.proctoringEvent.create as jest.Mock).mockImplementation(
      async ({ data }) => {
        if (data.eventType === ProctorEventType.AI_FLAG_CONFIRMED) {
          captured.retainUntil = data.retainUntil as Date;
        }
        return { id: 'ev', ...data };
      },
    );

    const svc = makeService(m);
    const before = Date.now();
    await svc.review(USER_ID, { sessionId: SESSION_ID, ts: before, imageBase64: FRAME_B64 });
    const after = Date.now();

    expect(captured.retainUntil).not.toBeNull();
    const ms = captured.retainUntil!.getTime();
    expect(ms).toBeGreaterThanOrEqual(before + 90 * 86_400_000 - 50);
    expect(ms).toBeLessThanOrEqual(after + 90 * 86_400_000 + 50);
  });

  it('bumps retainUntil to +2y when an active UserPenalty is tied to the session', async () => {
    const m = makeMocks();
    (m.prisma.examSession.findUnique as jest.Mock).mockResolvedValue(makeSession());
    (m.prisma.userPenalty.findFirst as jest.Mock).mockResolvedValue({
      id: 'pen-1',
      sessionId: SESSION_ID,
      userId: USER_ID,
      status: PenaltyStatus.ACTIVE,
    });
    (m.gemini.screen as jest.Mock).mockResolvedValue({
      suspicious: true,
      confidence: 0.9,
      flags: ['PHONE_IN_FRAME'],
      notes: '',
      modelMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      degraded: false,
    });
    (m.claude.verifyAndCaption as jest.Mock).mockResolvedValue({
      confirmed: true,
      severity: 'HIGH',
      ruleBroken: 'PHONE_IN_FRAME',
      captionKo: '휴대전화가 사용 중입니다.',
      captionEn: 'A phone is in use.',
      modelMs: 1,
      degraded: false,
    });
    const captured: { retainUntil: Date | null; severity: string | null; tier: string | null } = {
      retainUntil: null, severity: null, tier: null,
    };
    (m.prisma.proctoringEvent.create as jest.Mock).mockImplementation(
      async ({ data }) => {
        if (data.eventType === ProctorEventType.AI_FLAG_CONFIRMED) {
          captured.retainUntil = data.retainUntil as Date;
          captured.severity = data.severity as string;
          const meta = (data.metadata ?? {}) as Record<string, unknown>;
          captured.tier = (meta.aiTier as string) ?? null;
        }
        return { id: 'ev', ...data };
      },
    );

    const svc = makeService(m);
    const before = Date.now();
    await svc.review(USER_ID, { sessionId: SESSION_ID, ts: before, imageBase64: FRAME_B64 });
    const after = Date.now();

    expect(captured.tier).toBe('CLAUDE');
    expect(captured.severity).toBe('HIGH');
    const ms = captured.retainUntil!.getTime();
    const TWO_YEARS = 365 * 2 * 86_400_000;
    expect(ms).toBeGreaterThanOrEqual(before + TWO_YEARS - 50);
    expect(ms).toBeLessThanOrEqual(after + TWO_YEARS + 50);
  });
});

describe('AiProctorService.review — Claude-offline fallback', () => {
  const baseGemini = (overrides: Partial<{
    confidence: number; flags: string[];
  }> = {}) => ({
    suspicious: true,
    confidence: overrides.confidence ?? 0.9,
    flags: overrides.flags ?? ['PHONE_IN_FRAME'],
    notes: '',
    modelMs: 100,
    inputTokens: 0,
    outputTokens: 0,
    degraded: false,
  });

  it('phone-class flag at conf >= 0.6 → AI_FLAG_CONFIRMED MED + PHONE_DETECTED strike, no Claude call', async () => {
    const m = makeMocks();
    (m.claude.isConfigured as jest.Mock).mockReturnValue(false);
    (m.prisma.examSession.findUnique as jest.Mock).mockResolvedValue(makeSession());
    (m.prisma.userPenalty.findFirst as jest.Mock).mockResolvedValue(null);
    (m.gemini.screen as jest.Mock).mockResolvedValue(
      baseGemini({ confidence: 0.65, flags: ['PHONE_IN_FRAME'] }),
    );
    const captured: { eventType: string | null; severity: string | null; tier: string | null; reason: string | null } = {
      eventType: null, severity: null, tier: null, reason: null,
    };
    (m.prisma.proctoringEvent.create as jest.Mock).mockImplementation(async ({ data }) => {
      captured.eventType = data.eventType as string;
      captured.severity = data.severity as string;
      const meta = (data.metadata ?? {}) as Record<string, unknown>;
      captured.tier = (meta.aiTier as string) ?? null;
      captured.reason = (meta.fallbackReason as string) ?? null;
      return { id: 'ev-1', ...data };
    });

    const svc = makeService(m);
    const res = await svc.review(USER_ID, { sessionId: SESSION_ID, ts: 1, imageBase64: FRAME_B64 });

    expect(res.aiVerdict).toBe('MED');
    expect(res.degraded).toBe(false);
    expect(captured.eventType).toBe(ProctorEventType.AI_FLAG_CONFIRMED);
    expect(captured.severity).toBe('MED');
    expect(captured.tier).toBe('GEMINI');
    expect(captured.reason).toBe('claude-not-configured');
    expect((m.claude.verifyAndCaption as jest.Mock).mock.calls.length).toBe(0);
    expect((m.cbtSessions.recordSystemProctorEvent as jest.Mock).mock.calls.length).toBe(1);
    expect((m.cbtSessions.recordSystemProctorEvent as jest.Mock).mock.calls[0][1]).toBe(
      ProctorEventType.PHONE_DETECTED,
    );
  });

  it('non-phone flag at conf >= 0.7 → AI_FLAG_CONFIRMED LOW, no PHONE_DETECTED strike', async () => {
    const m = makeMocks();
    (m.claude.isConfigured as jest.Mock).mockReturnValue(false);
    (m.prisma.examSession.findUnique as jest.Mock).mockResolvedValue(makeSession());
    (m.prisma.userPenalty.findFirst as jest.Mock).mockResolvedValue(null);
    (m.gemini.screen as jest.Mock).mockResolvedValue(
      baseGemini({ confidence: 0.75, flags: ['HEADPHONES_OR_EARBUDS'] }),
    );
    const captured: { severity: string | null; reason: string | null } = { severity: null, reason: null };
    (m.prisma.proctoringEvent.create as jest.Mock).mockImplementation(async ({ data }) => {
      captured.severity = data.severity as string;
      captured.reason = ((data.metadata ?? {}) as Record<string, unknown>).fallbackReason as string ?? null;
      return { id: 'ev-2', ...data };
    });

    const svc = makeService(m);
    const res = await svc.review(USER_ID, { sessionId: SESSION_ID, ts: 2, imageBase64: FRAME_B64 });

    expect(res.aiVerdict).toBe('LOW');
    expect(captured.severity).toBe('LOW');
    expect(captured.reason).toBe('claude-not-configured');
    expect((m.cbtSessions.recordSystemProctorEvent as jest.Mock).mock.calls.length).toBe(0);
  });

  it('phone-class below 0.6 → AI_FLAG_SUSPICIOUS only (no strike, no banner)', async () => {
    const m = makeMocks();
    (m.claude.isConfigured as jest.Mock).mockReturnValue(false);
    (m.prisma.examSession.findUnique as jest.Mock).mockResolvedValue(makeSession());
    (m.prisma.userPenalty.findFirst as jest.Mock).mockResolvedValue(null);
    (m.gemini.screen as jest.Mock).mockResolvedValue(
      baseGemini({ confidence: 0.45, flags: ['PHONE_IN_FRAME'] }),
    );
    let lastEventType: string | null = null;
    (m.prisma.proctoringEvent.create as jest.Mock).mockImplementation(async ({ data }) => {
      lastEventType = data.eventType as string;
      return { id: 'ev-3', ...data };
    });
    (m.prisma.proctoringEvent.findFirst as jest.Mock).mockResolvedValue(null);

    const svc = makeService(m);
    const res = await svc.review(USER_ID, { sessionId: SESSION_ID, ts: 3, imageBase64: FRAME_B64 });

    expect(res.aiVerdict).toBe('OK');
    expect(lastEventType).toBe(ProctorEventType.AI_FLAG_SUSPICIOUS);
    expect((m.cbtSessions.recordSystemProctorEvent as jest.Mock).mock.calls.length).toBe(0);
    expect((m.ncp.put as jest.Mock).mock.calls.length).toBe(0);
  });

  it('LOOKING_OFF_SCREEN at conf >= 0.5 → AI_FLAG_CONFIRMED MED + GAZE_AWAY strike (Duolingo-strict)', async () => {
    const m = makeMocks();
    (m.claude.isConfigured as jest.Mock).mockReturnValue(false);
    (m.prisma.examSession.findUnique as jest.Mock).mockResolvedValue(makeSession());
    (m.prisma.userPenalty.findFirst as jest.Mock).mockResolvedValue(null);
    (m.gemini.screen as jest.Mock).mockResolvedValue(
      baseGemini({ confidence: 0.55, flags: ['LOOKING_OFF_SCREEN'] }),
    );
    const captured: { eventType: string | null; severity: string | null; ruleBroken: string | null } = {
      eventType: null, severity: null, ruleBroken: null,
    };
    (m.prisma.proctoringEvent.create as jest.Mock).mockImplementation(async ({ data }) => {
      captured.eventType = data.eventType as string;
      captured.severity = data.severity as string;
      const meta = (data.metadata ?? {}) as Record<string, unknown>;
      captured.ruleBroken = (meta.aiRuleBroken as string) ?? null;
      return { id: 'ev-gaze-1', ...data };
    });

    const svc = makeService(m);
    const res = await svc.review(USER_ID, { sessionId: SESSION_ID, ts: 10, imageBase64: FRAME_B64 });

    expect(res.aiVerdict).toBe('MED');
    expect(captured.eventType).toBe(ProctorEventType.AI_FLAG_CONFIRMED);
    expect(captured.severity).toBe('MED');
    expect(captured.ruleBroken).toBe('LOOKING_OFF_SCREEN');
    expect((m.cbtSessions.recordSystemProctorEvent as jest.Mock).mock.calls.length).toBe(1);
    expect((m.cbtSessions.recordSystemProctorEvent as jest.Mock).mock.calls[0][1]).toBe(
      ProctorEventType.GAZE_AWAY,
    );
  });

  it('LOOKING_OFF_SCREEN below 0.5 → AI_FLAG_SUSPICIOUS only (no GAZE_AWAY strike)', async () => {
    const m = makeMocks();
    (m.claude.isConfigured as jest.Mock).mockReturnValue(false);
    (m.prisma.examSession.findUnique as jest.Mock).mockResolvedValue(makeSession());
    (m.prisma.userPenalty.findFirst as jest.Mock).mockResolvedValue(null);
    (m.gemini.screen as jest.Mock).mockResolvedValue(
      baseGemini({ confidence: 0.4, flags: ['LOOKING_OFF_SCREEN'] }),
    );
    let lastEventType: string | null = null;
    (m.prisma.proctoringEvent.create as jest.Mock).mockImplementation(async ({ data }) => {
      lastEventType = data.eventType as string;
      return { id: 'ev-gaze-2', ...data };
    });
    (m.prisma.proctoringEvent.findFirst as jest.Mock).mockResolvedValue(null);

    const svc = makeService(m);
    const res = await svc.review(USER_ID, { sessionId: SESSION_ID, ts: 11, imageBase64: FRAME_B64 });

    expect(res.aiVerdict).toBe('OK');
    expect(lastEventType).toBe(ProctorEventType.AI_FLAG_SUSPICIOUS);
    expect((m.cbtSessions.recordSystemProctorEvent as jest.Mock).mock.calls.length).toBe(0);
  });
});

describe('AiProctorService.review — Claude-online gaze strike', () => {
  it('Gemini sees LOOKING_OFF_SCREEN AND Claude confirms → AI_FLAG_CONFIRMED + GAZE_AWAY strike', async () => {
    const m = makeMocks();
    (m.prisma.examSession.findUnique as jest.Mock).mockResolvedValue(makeSession());
    (m.prisma.userPenalty.findFirst as jest.Mock).mockResolvedValue(null);
    (m.gemini.screen as jest.Mock).mockResolvedValue({
      suspicious: true,
      confidence: 0.85,
      flags: ['LOOKING_OFF_SCREEN'],
      notes: '',
      modelMs: 100,
      inputTokens: 0,
      outputTokens: 0,
      degraded: false,
    });
    (m.claude.verifyAndCaption as jest.Mock).mockResolvedValue({
      confirmed: true,
      severity: 'MED',
      ruleBroken: 'LOOKING_OFF_SCREEN',
      captionKo: '시선이 화면을 벗어났습니다.',
      captionEn: 'Eyes off the screen.',
      modelMs: 200,
      degraded: false,
    });
    (m.prisma.proctoringEvent.create as jest.Mock).mockImplementation(async ({ data }) => ({
      id: 'ev-online-gaze', ...data,
    }));

    const svc = makeService(m);
    await svc.review(USER_ID, { sessionId: SESSION_ID, ts: 100, imageBase64: FRAME_B64 });

    const strikeCalls = (m.cbtSessions.recordSystemProctorEvent as jest.Mock).mock.calls;
    expect(strikeCalls.length).toBe(1);
    expect(strikeCalls[0][1]).toBe(ProctorEventType.GAZE_AWAY);
    const meta = strikeCalls[0][2] as Record<string, unknown>;
    expect(meta.origin).toBe('AI_FLAG_CONFIRMED');
    expect(meta.flags).toEqual(['LOOKING_OFF_SCREEN']);
  });

  it('Mixed phone+gaze flags both confirmed → fires PHONE_DETECTED AND GAZE_AWAY strikes', async () => {
    const m = makeMocks();
    (m.prisma.examSession.findUnique as jest.Mock).mockResolvedValue(makeSession());
    (m.prisma.userPenalty.findFirst as jest.Mock).mockResolvedValue(null);
    (m.gemini.screen as jest.Mock).mockResolvedValue({
      suspicious: true,
      confidence: 0.9,
      flags: ['PHONE_IN_FRAME', 'LOOKING_OFF_SCREEN'],
      notes: '',
      modelMs: 100,
      inputTokens: 0,
      outputTokens: 0,
      degraded: false,
    });
    (m.claude.verifyAndCaption as jest.Mock).mockResolvedValue({
      confirmed: true,
      severity: 'HIGH',
      ruleBroken: 'PHONE_IN_FRAME',
      captionKo: '휴대전화 사용이 감지되었습니다.',
      captionEn: 'Phone use detected.',
      modelMs: 200,
      degraded: false,
    });
    (m.prisma.proctoringEvent.create as jest.Mock).mockImplementation(async ({ data }) => ({
      id: 'ev-mixed', ...data,
    }));

    const svc = makeService(m);
    await svc.review(USER_ID, { sessionId: SESSION_ID, ts: 101, imageBase64: FRAME_B64 });

    const strikeCalls = (m.cbtSessions.recordSystemProctorEvent as jest.Mock).mock.calls;
    expect(strikeCalls.length).toBe(2);
    const types = strikeCalls.map((c) => c[1]).sort();
    expect(types).toEqual([ProctorEventType.GAZE_AWAY, ProctorEventType.PHONE_DETECTED].sort());
  });
});

import {
  CertLevel,
  CertType,
  ExamSessionStatus,
  ProctorEventType,
} from '@prisma/client';
import { CbtSessionsService } from './cbt-sessions.service';
import {
  LAST_SCREEN_FRAME_KEY,
  LAST_WEBCAM_FRAME_KEY,
} from '../adminMonitor/admin-monitor.gateway';
import type { PrismaService } from '../../common/prisma.service';
import type { AdminMonitorGateway } from '../adminMonitor/admin-monitor.gateway';
import type { MonitorHeartbeatService } from '../adminMonitor/monitor-heartbeat.service';
import type { RedisService } from '../../integrations/redis/redis.service';
import type { NcObjectStorageService } from '../../integrations/ncObjectStorage/nc-object-storage.service';
import type { ConfigService } from '@nestjs/config';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SESSION_ID = 'sess-1';
const USER_ID = 'user-1';
const FRAME_B64 = Buffer.from('test-jpeg-bytes').toString('base64');

function makeMocks() {
  const examSessionFindUnique = jest.fn(async () => ({
    id: SESSION_ID,
    userId: USER_ID,
    certType: CertType.AXIS,
    level: CertLevel.L2,
    status: ExamSessionStatus.IN_PROGRESS,
    proctorWarnings: 0,
  }));
  const proctoringEventCreate = jest.fn(async ({ data }: any) => ({
    id: 'ev-new',
    ...data,
  }));
  const proctoringEventFindUnique = jest.fn(async () => ({
    id: 'ev-new',
    metadata: { source: 'CLIENT', sustainedMs: 3200 },
  }));
  const proctoringEventUpdate = jest.fn(async () => ({}));
  const examSessionUpdate = jest.fn(async ({ data }: any) => ({
    id: SESSION_ID,
    certType: CertType.AXIS,
    level: CertLevel.L2,
    status: data.status ?? ExamSessionStatus.IN_PROGRESS,
    proctorWarnings: data.proctorWarnings ?? 1,
  }));

  const tx = {
    examSession: { findUnique: examSessionFindUnique, update: examSessionUpdate },
    proctoringEvent: { create: proctoringEventCreate },
  };
  const prisma = {
    $transaction: jest.fn(async (cb: any) => cb(tx)),
    proctoringEvent: { findUnique: proctoringEventFindUnique, update: proctoringEventUpdate },
  } as unknown as PrismaService;

  const adminMonitor = {
    emitSessionUpdate: jest.fn(async () => undefined),
  } as unknown as AdminMonitorGateway;
  const heartbeat = {
    markAlive: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
  } as unknown as MonitorHeartbeatService;

  const redisGet = jest.fn();
  const redis = {
    isReady: jest.fn(() => true),
    get: redisGet,
    set: jest.fn(async () => undefined),
  } as unknown as RedisService;

  const ncpPut = jest.fn(async () => ({ key: 'k', bucket: 'axis-snapshots', bytes: 1 }));
  const ncp = {
    bucketSnapshots: jest.fn(() => 'axis-snapshots'),
    put: ncpPut,
  } as unknown as NcObjectStorageService;
  const config = {
    get: jest.fn(() => false),
  } as unknown as ConfigService;

  return {
    prisma,
    adminMonitor,
    heartbeat,
    redis,
    ncp,
    config,
    examSessionFindUnique,
    proctoringEventCreate,
    proctoringEventFindUnique,
    proctoringEventUpdate,
    examSessionUpdate,
    redisGet,
    ncpPut,
  };
}

function makeService(m: ReturnType<typeof makeMocks>): CbtSessionsService {
  return new CbtSessionsService(m.prisma, m.adminMonitor, { notify: jest.fn() } as never, m.heartbeat, m.redis, m.ncp, m.config);
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('CbtSessionsService — heuristic evidence attach', () => {
  it('GAZE_AWAY: pulls cached webcam + screen frame, uploads to NCP, patches the event row', async () => {
    const m = makeMocks();
    const ts = Date.now();
    m.redisGet.mockImplementation(async (key: string) => {
      if (key === LAST_WEBCAM_FRAME_KEY(SESSION_ID)) return `${ts}|${FRAME_B64}`;
      if (key === LAST_SCREEN_FRAME_KEY(SESSION_ID)) return `${ts}|${FRAME_B64}`;
      return null;
    });

    const svc = makeService(m);
    const res = await svc.recordProctorEvent(USER_ID, SESSION_ID, ProctorEventType.GAZE_AWAY, {
      sustainedMs: 3200,
    });

    expect(res.warningCount).toBe(1);
    expect(res.terminated).toBe(false);

    await flushMicrotasks();

    expect(m.redisGet).toHaveBeenCalledWith(LAST_WEBCAM_FRAME_KEY(SESSION_ID));
    expect(m.redisGet).toHaveBeenCalledWith(LAST_SCREEN_FRAME_KEY(SESSION_ID));
    expect(m.ncpPut).toHaveBeenCalledTimes(2);

    expect(m.proctoringEventUpdate).toHaveBeenCalledTimes(1);
    const updateArg = (m.proctoringEventUpdate as jest.Mock).mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 'ev-new' });
    expect(updateArg.data.evidenceUrl).toMatch(/^proctor\/sess-1\/heuristic\//);
    expect((updateArg.data.metadata as Record<string, unknown>).screenEvidenceUrl).toMatch(
      /^proctor\/sess-1\/heuristic-screen\//,
    );
    expect((updateArg.data.metadata as Record<string, unknown>).evidenceSource).toBe(
      'cached-live-frame',
    );
    expect(updateArg.data.retainUntil).toBeInstanceOf(Date);
  });

  // Page-leave class — FULLSCREEN_EXIT / TAB_SWITCH / WINDOW_BLUR /
  // TAB_HIDDEN / BEFORE_UNLOAD — was promoted into VISUAL_HEURISTIC_EVENTS
  // so the admin "Cheating evidence" modal can render a webcam + screen
  // thumbnail at the moment the candidate left the exam window. The
  // pipeline is identical to GAZE_AWAY above; we just verify on a
  // representative leave-class event here.
  it('TAB_HIDDEN (page-leave): pulls cached webcam + screen frame, patches the row', async () => {
    const m = makeMocks();
    const ts = Date.now();
    m.redisGet.mockImplementation(async (key: string) => {
      if (key === LAST_WEBCAM_FRAME_KEY(SESSION_ID)) return `${ts}|${FRAME_B64}`;
      if (key === LAST_SCREEN_FRAME_KEY(SESSION_ID)) return `${ts}|${FRAME_B64}`;
      return null;
    });

    const svc = makeService(m);
    await svc.recordProctorEvent(USER_ID, SESSION_ID, ProctorEventType.TAB_HIDDEN, {});
    await flushMicrotasks();

    expect(m.redisGet).toHaveBeenCalledWith(LAST_WEBCAM_FRAME_KEY(SESSION_ID));
    expect(m.redisGet).toHaveBeenCalledWith(LAST_SCREEN_FRAME_KEY(SESSION_ID));
    expect(m.ncpPut).toHaveBeenCalledTimes(2);
    expect(m.proctoringEventUpdate).toHaveBeenCalledTimes(1);
  });

  it('FULLSCREEN_EXIT (page-leave): attaches cached frames the same way', async () => {
    const m = makeMocks();
    const ts = Date.now();
    m.redisGet.mockImplementation(async (key: string) => {
      if (key === LAST_WEBCAM_FRAME_KEY(SESSION_ID)) return `${ts}|${FRAME_B64}`;
      if (key === LAST_SCREEN_FRAME_KEY(SESSION_ID)) return `${ts}|${FRAME_B64}`;
      return null;
    });

    const svc = makeService(m);
    await svc.recordProctorEvent(USER_ID, SESSION_ID, ProctorEventType.FULLSCREEN_EXIT, {});
    await flushMicrotasks();

    expect(m.ncpPut).toHaveBeenCalledTimes(2);
    expect(m.proctoringEventUpdate).toHaveBeenCalledTimes(1);
  });

  it('does NOT attach evidence for truly non-visual events (EXTERNAL_DISPLAY)', async () => {
    const m = makeMocks();
    m.redisGet.mockResolvedValue(`${Date.now()}|${FRAME_B64}`);

    const svc = makeService(m);
    await svc.recordProctorEvent(USER_ID, SESSION_ID, ProctorEventType.EXTERNAL_DISPLAY, {});
    await flushMicrotasks();

    expect(m.redisGet).not.toHaveBeenCalled();
    expect(m.ncpPut).not.toHaveBeenCalled();
    expect(m.proctoringEventUpdate).not.toHaveBeenCalled();
  });

  it('skips NCP + DB update when both Redis frames are missing', async () => {
    const m = makeMocks();
    m.redisGet.mockResolvedValue(null);

    const svc = makeService(m);
    await svc.recordProctorEvent(USER_ID, SESSION_ID, ProctorEventType.NO_FACE, {});
    await flushMicrotasks();

    expect(m.redisGet).toHaveBeenCalledTimes(2);
    expect(m.ncpPut).not.toHaveBeenCalled();
    expect(m.proctoringEventUpdate).not.toHaveBeenCalled();
  });

  it('skips stale frames (>60s old) — a stale shot would mislead the auditor', async () => {
    const m = makeMocks();
    const stale = Date.now() - 90_000;
    m.redisGet.mockResolvedValue(`${stale}|${FRAME_B64}`);

    const svc = makeService(m);
    await svc.recordProctorEvent(USER_ID, SESSION_ID, ProctorEventType.MULTIPLE_FACES, {});
    await flushMicrotasks();

    expect(m.ncpPut).not.toHaveBeenCalled();
    expect(m.proctoringEventUpdate).not.toHaveBeenCalled();
  });

  it('NCP failure on webcam still uploads screen and patches with screen-only key', async () => {
    const m = makeMocks();
    const ts = Date.now();
    m.redisGet.mockImplementation(async (key: string) => {
      if (key === LAST_WEBCAM_FRAME_KEY(SESSION_ID)) return `${ts}|${FRAME_B64}`;
      if (key === LAST_SCREEN_FRAME_KEY(SESSION_ID)) return `${ts}|${FRAME_B64}`;
      return null;
    });
    let callIdx = 0;
    (m.ncp.put as jest.Mock).mockImplementation(async () => {
      callIdx += 1;
      if (callIdx === 1) throw new Error('webcam upload boom');
      return { key: 'k', bucket: 'axis-snapshots', bytes: 1 };
    });

    const svc = makeService(m);
    await svc.recordProctorEvent(USER_ID, SESSION_ID, ProctorEventType.PHONE_DETECTED, {});
    await flushMicrotasks();

    expect(m.proctoringEventUpdate).toHaveBeenCalledTimes(1);
    const updateArg = (m.proctoringEventUpdate as jest.Mock).mock.calls[0][0];
    expect(updateArg.data.evidenceUrl).toBeUndefined();
    expect((updateArg.data.metadata as Record<string, unknown>).screenEvidenceUrl).toMatch(
      /^proctor\/sess-1\/heuristic-screen\//,
    );
  });

  it('Redis-offline path: ncp.put never called, no DB update, no throw', async () => {
    const m = makeMocks();
    m.redisGet.mockResolvedValue(null);
    (m.redis.isReady as jest.Mock).mockReturnValue(false);

    const svc = makeService(m);
    await expect(
      svc.recordProctorEvent(USER_ID, SESSION_ID, ProctorEventType.EYES_CLOSED, {}),
    ).resolves.toBeDefined();
    await flushMicrotasks();

    expect(m.ncpPut).not.toHaveBeenCalled();
    expect(m.proctoringEventUpdate).not.toHaveBeenCalled();
  });

  it('public response shape excludes the internal eventId field', async () => {
    const m = makeMocks();
    m.redisGet.mockResolvedValue(null);

    const svc = makeService(m);
    const res = await svc.recordProctorEvent(USER_ID, SESSION_ID, ProctorEventType.TAB_HIDDEN, {});
    expect(res).not.toHaveProperty('eventId');
    expect(res).toMatchObject({
      type: ProctorEventType.TAB_HIDDEN,
      warningCount: expect.any(Number),
      terminated: expect.any(Boolean),
      status: expect.any(String),
    });
  });
});

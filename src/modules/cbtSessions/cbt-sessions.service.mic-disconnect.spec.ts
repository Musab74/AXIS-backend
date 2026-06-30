import {
  CertLevel,
  CertType,
  ExamSessionStatus,
  ProctorEventType,
} from '@prisma/client';
import { CbtSessionsService } from './cbt-sessions.service';
import type { PrismaService } from '../../common/prisma.service';
import type { AdminMonitorGateway } from '../adminMonitor/admin-monitor.gateway';
import type { MonitorHeartbeatService } from '../adminMonitor/monitor-heartbeat.service';
import type { RedisService } from '../../integrations/redis/redis.service';
import type { NcObjectStorageService } from '../../integrations/ncObjectStorage/nc-object-storage.service';
import type { ConfigService } from '@nestjs/config';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SESSION_ID = 'sess-mic-1';
const USER_ID = 'user-mic-1';

interface SessionShape {
  id: string;
  userId: string;
  certType: CertType;
  level: CertLevel;
  status: ExamSessionStatus;
  proctorWarnings: number;
  failReason?: string | null;
}

function makeMocks(initial: Partial<SessionShape> = {}) {
  const session: SessionShape = {
    id: SESSION_ID,
    userId: USER_ID,
    certType: CertType.AXIS,
    level: CertLevel.L2,
    status: ExamSessionStatus.IN_PROGRESS,
    proctorWarnings: 0,
    failReason: null,
    ...initial,
  };

  const examSessionFindUnique = jest.fn(async () => ({ ...session }));
  const proctoringEventCreate = jest.fn(async ({ data }: any) => ({
    id: 'ev-mic',
    ...data,
  }));
  const examSessionUpdate = jest.fn(async ({ data }: any) => {
    Object.assign(session, data);
    return { ...session };
  });

  const tx = {
    examSession: { findUnique: examSessionFindUnique, update: examSessionUpdate },
    proctoringEvent: { create: proctoringEventCreate },
  };
  const prisma = {
    $transaction: jest.fn(async (cb: any) => cb(tx)),
    proctoringEvent: { findUnique: jest.fn(), update: jest.fn() },
    // Stubs for the fire-and-forget closeRegistrationIfFinished call kicked
    // off after termination — we don't assert against them here, just keep
    // the helper from spamming warn-logs about "undefined .findUnique".
    examSession: {
      findUnique: jest.fn(async () => ({ id: SESSION_ID, registrationId: null })),
      findMany: jest.fn(async () => []),
    },
    registration: { findUnique: jest.fn(async () => null), update: jest.fn() },
  } as unknown as PrismaService;

  const adminMonitor = {
    emitSessionUpdate: jest.fn(async () => undefined),
  } as unknown as AdminMonitorGateway;
  const heartbeat = {
    markAlive: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
  } as unknown as MonitorHeartbeatService;
  const redis = {
    isReady: jest.fn(() => false),
    get: jest.fn(),
    set: jest.fn(async () => undefined),
  } as unknown as RedisService;
  const ncp = {
    bucketSnapshots: jest.fn(() => 'axis-snapshots'),
    put: jest.fn(),
  } as unknown as NcObjectStorageService;
  const config = {
    get: jest.fn(() => false),
  } as unknown as ConfigService;

  return {
    session,
    prisma,
    adminMonitor,
    heartbeat,
    redis,
    ncp,
    config,
    examSessionFindUnique,
    proctoringEventCreate,
    examSessionUpdate,
  };
}

function makeService(m: ReturnType<typeof makeMocks>): CbtSessionsService {
  return new CbtSessionsService(m.prisma, m.adminMonitor, { notify: jest.fn() } as never, m.heartbeat, m.redis, m.ncp, m.config);
}

describe('CbtSessionsService — terminateForMicDisconnect', () => {
  it('IN_PROGRESS session: writes AUDIO_HIGH audit row + force-terminates with mic-specific failReason', async () => {
    const m = makeMocks();
    const svc = makeService(m);

    const res = await svc.terminateForMicDisconnect(USER_ID, SESSION_ID, {
      reason: 'ENDED',
      detail: { durationMs: 8200 },
    });

    expect(res.terminated).toBe(true);
    expect(res.status).toBe(ExamSessionStatus.TERMINATED);
    expect(res.action).toBe('TERMINATED');
    expect(res.failReason).toMatch(/microphone disconnected/i);
    expect(res.failReason).toMatch(/ENDED/);
    expect(res.warningCount).toBe(3); // saturated to threshold

    expect(m.proctoringEventCreate).toHaveBeenCalledTimes(1);
    const createArgs = m.proctoringEventCreate.mock.calls[0][0] as any;
    expect(createArgs.data.eventType).toBe(ProctorEventType.AUDIO_HIGH);
    expect(createArgs.data.metadata).toMatchObject({
      kind: 'MIC_DISCONNECTED',
      reason: 'ENDED',
      terminate: true,
      source: 'CLIENT',
      durationMs: 8200,
    });

    expect(m.examSessionUpdate).toHaveBeenCalledTimes(1);
    const updateArgs = m.examSessionUpdate.mock.calls[0][0] as any;
    expect(updateArgs.data.status).toBe(ExamSessionStatus.TERMINATED);
    expect(updateArgs.data.failReason).toMatch(/microphone disconnected/i);
    expect(updateArgs.data.proctorWarnings).toBe(3);
    expect(updateArgs.data.submittedAt).toBeInstanceOf(Date);

    expect(m.adminMonitor.emitSessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, status: 'terminated' }),
    );
    expect(m.heartbeat.clear).toHaveBeenCalledWith(SESSION_ID);
  });

  it('idempotent: second call against an already-TERMINATED session writes audit but does not re-update', async () => {
    const m = makeMocks({ status: ExamSessionStatus.TERMINATED, proctorWarnings: 3 });
    const svc = makeService(m);

    const res = await svc.terminateForMicDisconnect(USER_ID, SESSION_ID, {
      reason: 'MUTED',
    });

    expect(res.terminated).toBe(true);
    expect(res.status).toBe(ExamSessionStatus.TERMINATED);
    expect(m.proctoringEventCreate).toHaveBeenCalledTimes(1); // audit always written
    expect(m.examSessionUpdate).not.toHaveBeenCalled(); // session already ended
    expect(m.adminMonitor.emitSessionUpdate).not.toHaveBeenCalled();
    expect(m.heartbeat.clear).not.toHaveBeenCalled();
  });

  it('rejects calls from a different user with ForbiddenException', async () => {
    const m = makeMocks();
    const svc = makeService(m);

    await expect(
      svc.terminateForMicDisconnect('not-the-owner', SESSION_ID, { reason: 'ENDED' }),
    ).rejects.toThrow('Not your session');

    expect(m.proctoringEventCreate).not.toHaveBeenCalled();
    expect(m.examSessionUpdate).not.toHaveBeenCalled();
  });

  it('defaults missing reason to "ENDED" and includes it in metadata + failReason', async () => {
    const m = makeMocks();
    const svc = makeService(m);

    const res = await svc.terminateForMicDisconnect(USER_ID, SESSION_ID, {});

    const createArgs = m.proctoringEventCreate.mock.calls[0][0] as any;
    expect(createArgs.data.metadata.reason).toBe('ENDED');
    expect(res.failReason).toMatch(/ENDED/);
  });
});

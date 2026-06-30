import { ExamSessionStatus, RegistrationStatus } from '@prisma/client';
import { CbtSessionsService } from './cbt-sessions.service';
import type { PrismaService } from '../../common/prisma.service';
import type { AdminMonitorGateway } from '../adminMonitor/admin-monitor.gateway';
import type { MonitorHeartbeatService } from '../adminMonitor/monitor-heartbeat.service';
import type { RedisService } from '../../integrations/redis/redis.service';
import type { NcObjectStorageService } from '../../integrations/ncObjectStorage/nc-object-storage.service';
import type { ConfigService } from '@nestjs/config';

/* eslint-disable @typescript-eslint/no-explicit-any */

const REG_ID = 'reg-1';
const SESSION_ID = 'sess-1';

interface SessionRow {
  id: string;
  status: ExamSessionStatus;
  passed: boolean | null;
}

function makeMocks(opts: {
  registrationStatus?: RegistrationStatus | null;
  sessions?: SessionRow[];
  sessionRegistrationId?: string | null;
}) {
  const regFindUnique = jest.fn(async ({ where }: any) => {
    if (opts.registrationStatus === null) return null;
    return {
      id: where.id,
      status: opts.registrationStatus ?? RegistrationStatus.PAID,
    };
  });
  const regUpdate = jest.fn(async ({ data }: any) => ({ id: REG_ID, ...data }));
  const examSessionFindMany = jest.fn(async () => opts.sessions ?? []);
  const examSessionFindUnique = jest.fn(async () => ({
    id: SESSION_ID,
    registrationId:
      opts.sessionRegistrationId === undefined ? REG_ID : opts.sessionRegistrationId,
  }));

  const prisma = {
    registration: { findUnique: regFindUnique, update: regUpdate },
    examSession: { findMany: examSessionFindMany, findUnique: examSessionFindUnique },
  } as unknown as PrismaService;

  const adminMonitor = {
    emitSessionUpdate: jest.fn(async () => undefined),
    broadcastLiveStatus: jest.fn(async () => undefined),
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
    prisma,
    adminMonitor,
    heartbeat,
    redis,
    ncp,
    config,
    regFindUnique,
    regUpdate,
    examSessionFindMany,
    examSessionFindUnique,
  };
}

function makeService(m: ReturnType<typeof makeMocks>): CbtSessionsService {
  return new CbtSessionsService(m.prisma, m.adminMonitor, { notify: jest.fn() } as never, m.heartbeat, m.redis, m.ncp, m.config);
}

describe('CbtSessionsService — closeRegistrationIfFinished', () => {
  it('PASS on attempt 1 → flips registration to EXAM_COMPLETED with reason=PASSED', async () => {
    const m = makeMocks({
      sessions: [{ id: 's1', status: ExamSessionStatus.GRADED, passed: true }],
    });
    const svc = makeService(m);

    const res = await svc.closeRegistrationIfFinished(REG_ID, null, 'submit');

    expect(res).toEqual({ closed: true, reason: 'PASSED', registrationId: REG_ID });
    expect(m.regUpdate).toHaveBeenCalledWith({
      where: { id: REG_ID },
      data: { status: RegistrationStatus.EXAM_COMPLETED },
    });
  });

  it('PASS on attempt 2 (1 prior fail) → still EXAM_COMPLETED with reason=PASSED', async () => {
    const m = makeMocks({
      sessions: [
        { id: 's1', status: ExamSessionStatus.GRADED, passed: false },
        { id: 's2', status: ExamSessionStatus.GRADED, passed: true },
      ],
    });
    const svc = makeService(m);

    const res = await svc.closeRegistrationIfFinished(REG_ID, null, 'finalize');

    expect(res.closed).toBe(true);
    expect(res.reason).toBe('PASSED');
    expect(m.regUpdate).toHaveBeenCalledTimes(1);
  });

  it('3 fails (no pass) → flips with reason=EXHAUSTED', async () => {
    const m = makeMocks({
      sessions: [
        { id: 's1', status: ExamSessionStatus.GRADED, passed: false },
        { id: 's2', status: ExamSessionStatus.GRADED, passed: false },
        { id: 's3', status: ExamSessionStatus.GRADED, passed: false },
      ],
    });
    const svc = makeService(m);

    const res = await svc.closeRegistrationIfFinished(REG_ID, null, 'submit');

    expect(res.closed).toBe(true);
    expect(res.reason).toBe('EXHAUSTED');
    expect(m.regUpdate).toHaveBeenCalledWith({
      where: { id: REG_ID },
      data: { status: RegistrationStatus.EXAM_COMPLETED },
    });
  });

  it('TERMINATED counts toward exhaustion just like SUBMITTED/GRADED', async () => {
    const m = makeMocks({
      sessions: [
        { id: 's1', status: ExamSessionStatus.TERMINATED, passed: null },
        { id: 's2', status: ExamSessionStatus.SUBMITTED, passed: null },
        { id: 's3', status: ExamSessionStatus.TERMINATED, passed: null },
      ],
    });
    const svc = makeService(m);

    const res = await svc.closeRegistrationIfFinished(REG_ID, null, 'mic-disconnected');

    expect(res.closed).toBe(true);
    expect(res.reason).toBe('EXHAUSTED');
  });

  it('2 terminal sessions + 1 IN_PROGRESS → still PAID, no flip yet', async () => {
    const m = makeMocks({
      sessions: [
        { id: 's1', status: ExamSessionStatus.GRADED, passed: false },
        { id: 's2', status: ExamSessionStatus.GRADED, passed: false },
        { id: 's3', status: ExamSessionStatus.IN_PROGRESS, passed: null },
      ],
    });
    const svc = makeService(m);

    const res = await svc.closeRegistrationIfFinished(REG_ID, null, 'strike-threshold');

    expect(res.closed).toBe(false);
    expect(m.regUpdate).not.toHaveBeenCalled();
  });

  it('already EXAM_COMPLETED → no-op (does not double-flip)', async () => {
    const m = makeMocks({
      registrationStatus: RegistrationStatus.EXAM_COMPLETED,
      sessions: [{ id: 's1', status: ExamSessionStatus.GRADED, passed: true }],
    });
    const svc = makeService(m);

    const res = await svc.closeRegistrationIfFinished(REG_ID, null, 'submit');

    expect(res.closed).toBe(false);
    expect(res.registrationId).toBe(REG_ID);
    expect(m.regUpdate).not.toHaveBeenCalled();
    expect(m.examSessionFindMany).not.toHaveBeenCalled();
  });

  it('CANCELLED registration → never overwritten', async () => {
    const m = makeMocks({
      registrationStatus: RegistrationStatus.CANCELLED,
      sessions: [{ id: 's1', status: ExamSessionStatus.GRADED, passed: true }],
    });
    const svc = makeService(m);

    const res = await svc.closeRegistrationIfFinished(REG_ID, null, 'submit');

    expect(res.closed).toBe(false);
    expect(m.regUpdate).not.toHaveBeenCalled();
  });

  it('REFUNDED registration → never overwritten', async () => {
    const m = makeMocks({
      registrationStatus: RegistrationStatus.REFUNDED,
      sessions: [
        { id: 's1', status: ExamSessionStatus.GRADED, passed: false },
        { id: 's2', status: ExamSessionStatus.GRADED, passed: false },
        { id: 's3', status: ExamSessionStatus.GRADED, passed: false },
      ],
    });
    const svc = makeService(m);

    const res = await svc.closeRegistrationIfFinished(REG_ID, null, 'submit');

    expect(res.closed).toBe(false);
    expect(m.regUpdate).not.toHaveBeenCalled();
  });

  it('null registrationId + null sessionId → silent no-op (admin-only sessions)', async () => {
    const m = makeMocks({});
    const svc = makeService(m);

    const res = await svc.closeRegistrationIfFinished(null, null, 'submit');

    expect(res.closed).toBe(false);
    expect(m.regFindUnique).not.toHaveBeenCalled();
    expect(m.regUpdate).not.toHaveBeenCalled();
  });

  it('resolves registrationId from sessionId when only the session is given', async () => {
    const m = makeMocks({
      sessions: [{ id: 's1', status: ExamSessionStatus.GRADED, passed: true }],
    });
    const svc = makeService(m);

    const res = await svc.closeRegistrationIfFinished(null, SESSION_ID, 'submit');

    expect(res.closed).toBe(true);
    expect(res.reason).toBe('PASSED');
    expect(m.examSessionFindUnique).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      select: { registrationId: true },
    });
  });

  it('session not linked to any registration (admin-created) → silent no-op', async () => {
    const m = makeMocks({
      sessionRegistrationId: null,
      sessions: [{ id: 's1', status: ExamSessionStatus.GRADED, passed: true }],
    });
    const svc = makeService(m);

    const res = await svc.closeRegistrationIfFinished(null, SESSION_ID, 'submit');

    expect(res.closed).toBe(false);
    expect(m.regFindUnique).not.toHaveBeenCalled();
  });

  it('registration not found → silent no-op (no throw)', async () => {
    const m = makeMocks({ registrationStatus: null });
    const svc = makeService(m);

    const res = await svc.closeRegistrationIfFinished(REG_ID, null, 'submit');

    expect(res.closed).toBe(false);
    expect(m.regUpdate).not.toHaveBeenCalled();
  });

  it('DB update failure → swallowed, never propagated to caller', async () => {
    const m = makeMocks({
      sessions: [{ id: 's1', status: ExamSessionStatus.GRADED, passed: true }],
    });
    (m.regUpdate as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    const svc = makeService(m);

    const res = await svc.closeRegistrationIfFinished(REG_ID, null, 'submit');
    expect(res.closed).toBe(false);
  });
});

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ExamSessionStatus, ProctorEventType } from '@prisma/client';
import { AdminMonitorActionsService } from './admin-monitor-actions.service';

describe('AdminMonitorActionsService', () => {
  const sessionId = 'sess-1';
  const actorId = 'admin-1';
  const baseSession = {
    id: sessionId,
    userId: 'user-1',
    status: ExamSessionStatus.IN_PROGRESS,
    certType: 'AXIS',
    level: 'L3',
    proctorWarnings: 0,
    hardDeadline: new Date('2026-06-26T12:00:00Z'),
    submittedAt: null,
    failReason: null,
    user: { name: 'Test User' },
  };

  const prisma = {
    examSession: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    proctoringEvent: {
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const pause = {
    getPauseState: jest.fn(),
    setPaused: jest.fn(),
    clearPaused: jest.fn(),
    isPaused: jest.fn(),
    assertNotPaused: jest.fn(),
  };

  const examGateway = {
    emitCandidateEvent: jest.fn(),
  };

  const adminMonitor = {
    emitAlert: jest.fn(),
    emitSessionUpdate: jest.fn(),
  };

  const notifications = { notify: jest.fn() };

  const heartbeat = { clear: jest.fn() };

  const cbtSessions = {
    closeRegistrationIfFinished: jest.fn(),
  };

  const svc = new AdminMonitorActionsService(
    prisma as never,
    pause as never,
    examGateway as never,
    adminMonitor as never,
    notifications as never,
    heartbeat as never,
    cbtSessions as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.examSession.findUnique.mockResolvedValue(baseSession);
    prisma.proctoringEvent.create.mockResolvedValue({ id: 'ev-1' });
    prisma.examSession.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...baseSession, ...data }),
    );
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    );
    pause.getPauseState.mockResolvedValue(null);
    pause.isPaused.mockResolvedValue(false);
  });

  it('warn creates MANUAL_FLAG without incrementing proctorWarnings', async () => {
    const res = await svc.warn(actorId, sessionId, 'Please focus');
    expect(res.action).toBe('warn');
    expect(prisma.proctoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: ProctorEventType.MANUAL_FLAG,
          metadata: expect.objectContaining({ kind: 'ADMIN_WARNING' }),
        }),
      }),
    );
    expect(prisma.examSession.update).not.toHaveBeenCalled();
    expect(examGateway.emitCandidateEvent).toHaveBeenCalledWith(
      sessionId,
      'exam:warning',
      expect.objectContaining({ message: 'Please focus' }),
    );
  });

  it('togglePause sets redis pause on first call', async () => {
    const res = await svc.togglePause(actorId, sessionId, 'Network issue');
    expect(res.action).toBe('pause');
    expect(res.timerPaused).toBe(true);
    expect(pause.setPaused).toHaveBeenCalled();
    expect(examGateway.emitCandidateEvent).toHaveBeenCalledWith(
      sessionId,
      'exam:timer-paused',
      expect.any(Object),
    );
  });

  it('togglePause extends deadline and clears pause on second call', async () => {
    pause.getPauseState.mockResolvedValue({
      pausedAt: Date.now() - 60_000,
      actorId,
    });
    const res = await svc.togglePause(actorId, sessionId);
    expect(res.action).toBe('resume');
    expect(pause.clearPaused).toHaveBeenCalledWith(sessionId);
    expect(prisma.examSession.update).toHaveBeenCalled();
    expect(examGateway.emitCandidateEvent).toHaveBeenCalledWith(
      sessionId,
      'exam:timer-resumed',
      expect.any(Object),
    );
  });

  it('extend shifts hardDeadline forward', async () => {
    const res = await svc.extend(actorId, sessionId, 300);
    expect(res.action).toBe('extend');
    expect(prisma.examSession.update).toHaveBeenCalled();
    expect(examGateway.emitCandidateEvent).toHaveBeenCalledWith(
      sessionId,
      'exam:time-extended',
      expect.objectContaining({ seconds: 300 }),
    );
  });

  it('terminate sets TERMINATED and emits force-terminate', async () => {
    const res = await svc.terminate(actorId, sessionId, 'Confirmed cheating');
    expect(res.action).toBe('terminate');
    expect(res.status).toBe(ExamSessionStatus.TERMINATED);
    expect(examGateway.emitCandidateEvent).toHaveBeenCalledWith(
      sessionId,
      'exam:force-terminate',
      expect.objectContaining({ reason: 'Confirmed cheating' }),
    );
    expect(cbtSessions.closeRegistrationIfFinished).toHaveBeenCalled();
  });

  it('warn rejects non-IN_PROGRESS session', async () => {
    prisma.examSession.findUnique.mockResolvedValue({
      ...baseSession,
      status: ExamSessionStatus.SUBMITTED,
    });
    await expect(svc.warn(actorId, sessionId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('extend rejects missing session', async () => {
    prisma.examSession.findUnique.mockResolvedValue(null);
    await expect(svc.extend(actorId, sessionId, 300)).rejects.toBeInstanceOf(NotFoundException);
  });
});

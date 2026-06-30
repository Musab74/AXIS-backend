import { BadRequestException } from '@nestjs/common';
import { assertIdentityVerifiedForSession } from './exam-identity-guard';

describe('assertIdentityVerifiedForSession', () => {
  const userId = 'user-1';
  const sessionId = 'sess-1';
  const sessionCreatedAt = new Date('2026-06-26T10:00:00Z');

  const prisma = {
    user: { findUnique: jest.fn() },
    examSession: { findUnique: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.examSession.findUnique.mockResolvedValue({
      id: sessionId,
      userId,
      createdAt: sessionCreatedAt,
    });
  });

  it('passes when reference face updated after session creation', async () => {
    prisma.user.findUnique.mockResolvedValue({
      referenceFaceImage: Buffer.from('face'),
      referenceFaceUpdatedAt: new Date('2026-06-26T10:05:00Z'),
    });
    await expect(
      assertIdentityVerifiedForSession(prisma as never, false, userId, sessionId),
    ).resolves.toBeUndefined();
  });

  it('rejects when reference face is missing', async () => {
    prisma.user.findUnique.mockResolvedValue({
      referenceFaceImage: null,
      referenceFaceUpdatedAt: null,
    });
    await expect(
      assertIdentityVerifiedForSession(prisma as never, false, userId, sessionId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when reference face predates session', async () => {
    prisma.user.findUnique.mockResolvedValue({
      referenceFaceImage: Buffer.from('face'),
      referenceFaceUpdatedAt: new Date('2026-06-26T09:00:00Z'),
    });
    await expect(
      assertIdentityVerifiedForSession(prisma as never, false, userId, sessionId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('skips when skipCheck is true', async () => {
    prisma.user.findUnique.mockResolvedValue({
      referenceFaceImage: null,
      referenceFaceUpdatedAt: null,
    });
    await expect(
      assertIdentityVerifiedForSession(prisma as never, true, userId, sessionId),
    ).resolves.toBeUndefined();
  });
});

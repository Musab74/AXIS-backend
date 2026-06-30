import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';

/**
 * Ensures the candidate completed identity verification for THIS session attempt.
 * referenceFaceImage is written on PASS from /identity-verification/verify;
 * referenceFaceUpdatedAt must be >= session.createdAt so an old selfie cannot
 * be reused across attempts.
 */
export async function assertIdentityVerifiedForSession(
  prisma: PrismaService,
  skipCheck: boolean,
  userId: string,
  sessionId: string,
): Promise<void> {
  if (skipCheck) return;

  const [user, session] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { referenceFaceImage: true, referenceFaceUpdatedAt: true },
    }),
    prisma.examSession.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true, createdAt: true },
    }),
  ]);

  if (!session || session.userId !== userId) {
    throw new BadRequestException('Session not found');
  }

  if (!user?.referenceFaceImage) {
    throw new BadRequestException(
      '본인확인이 필요합니다. 시험 시작 전 신원 확인을 완료해주세요.',
    );
  }

  if (
    !user.referenceFaceUpdatedAt ||
    user.referenceFaceUpdatedAt.getTime() < session.createdAt.getTime()
  ) {
    throw new BadRequestException('이번 응시를 위한 신원 확인이 필요합니다.');
  }
}

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CertLevel, CertType, ExamSessionStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { LEVEL_TIMING } from './exam-spec';

@Injectable()
export class CbtSessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, certType: CertType, level: CertLevel) {
    const lastAttempt = await this.prisma.examSession.findFirst({
      where: { userId, certType, level },
      orderBy: { attemptNo: 'desc' },
    });
    return this.prisma.examSession.create({
      data: {
        userId,
        certType,
        level,
        attemptNo: (lastAttempt?.attemptNo ?? 0) + 1,
        status: ExamSessionStatus.CREATED,
      },
    });
  }

  async listMine(userId: string) {
    return this.prisma.examSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async getOwned(userId: string, sessionId: string) {
    const s = await this.prisma.examSession.findUnique({ where: { id: sessionId } });
    if (!s) throw new NotFoundException('Session not found');
    if (s.userId !== userId) throw new ForbiddenException('Not your session');
    return s;
  }

  async start(userId: string, sessionId: string) {
    const s = await this.getOwned(userId, sessionId);
    if (s.status !== ExamSessionStatus.CREATED) {
      if (s.status === ExamSessionStatus.IN_PROGRESS) return s;
      throw new BadRequestException(`Cannot start a session in status ${s.status}`);
    }

    const seed = randomUUID();
    const timing = LEVEL_TIMING[s.level];
    const startedAt = new Date();
    const hardDeadline = new Date(startedAt.getTime() + timing.totalMinutes * 60_000);

    return this.prisma.$transaction(async (tx) => {
      const questions = await tx.questionBank.findMany({
        where: { certType: s.certType, level: s.level, active: true },
        orderBy: [{ subjectIndex: 'asc' }, { id: 'asc' }],
      });
      if (questions.length === 0) {
        throw new BadRequestException('Question bank empty for this exam — run prisma seed-exam first.');
      }
      const shuffled = shuffleWithSeed(questions, seed);
      await tx.answer.createMany({
        data: shuffled.map((q, i) => ({
          sessionId,
          questionId: q.id,
          qVersion: q.qVersion,
          contentSnapshot: { stem: q.stem, choices: q.choices, subjectName: q.subjectName, points: q.points } as Prisma.InputJsonValue,
          orderIndex: i,
        })),
      });
      return tx.examSession.update({
        where: { id: sessionId },
        data: { status: ExamSessionStatus.IN_PROGRESS, paperSeed: seed, startedAt, hardDeadline },
      });
    });
  }
}

function shuffleWithSeed<T>(items: T[], seed: string): T[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    const j = h % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ExamSessionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';

@Injectable()
export class CbtPracticalService {
  constructor(private readonly prisma: PrismaService) {}

  async save(
    userId: string,
    sessionId: string,
    body: {
      taskId: string;
      contentText: string;
      aiChatLog?: { role: 'user' | 'assistant'; text: string; ts: number }[];
      version: number;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.examSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new NotFoundException();
      if (session.userId !== userId) throw new ForbiddenException();
      if (session.status !== ExamSessionStatus.IN_PROGRESS) throw new BadRequestException('Exam not in progress');
      if (session.hardDeadline && new Date() > session.hardDeadline) throw new BadRequestException('Time over');

      const task = await tx.taskTemplate.findUnique({ where: { id: body.taskId } });
      if (!task) throw new NotFoundException('Task not found');
      if (task.certType !== session.certType || task.level !== session.level) {
        throw new BadRequestException('Task does not belong to this exam');
      }

      const existing = await tx.essayAnswer.findUnique({
        where: { sessionId_taskId: { sessionId, taskId: body.taskId } },
      });
      if (existing) {
        if (existing.version !== body.version) {
          throw new ConflictException({ message: 'Version mismatch', currentVersion: existing.version });
        }
        const updated = await tx.essayAnswer.update({
          where: { id: existing.id },
          data: {
            contentText: body.contentText,
            aiChatLog: (body.aiChatLog ?? null) as Prisma.InputJsonValue,
            version: { increment: 1 },
          },
        });
        return { taskId: body.taskId, version: updated.version };
      }
      if (body.version !== 0) throw new ConflictException({ message: 'Initial save must use version 0', currentVersion: 0 });
      const created = await tx.essayAnswer.create({
        data: {
          sessionId,
          taskId: body.taskId,
          part: task.part,
          contentText: body.contentText,
          aiChatLog: (body.aiChatLog ?? null) as Prisma.InputJsonValue,
          version: 1,
        },
      });
      return { taskId: body.taskId, version: created.version };
    });
  }
}

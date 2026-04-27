import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ExamSessionStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { LEVEL_TIMING } from '../cbtSessions/exam-spec';

@Injectable()
export class CbtExamsService {
  constructor(private readonly prisma: PrismaService) {}

  async getPaper(userId: string, sessionId: string) {
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      include: { answers: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.userId !== userId) throw new ForbiddenException();
    if (session.status === ExamSessionStatus.CREATED) throw new BadRequestException('Session not started');

    const tasks = await this.prisma.taskTemplate.findMany({
      where: { certType: session.certType, level: session.level },
      orderBy: [{ part: 'asc' }, { orderIndex: 'asc' }],
    });

    const timing = LEVEL_TIMING[session.level];
    return {
      session: {
        id: session.id,
        certType: session.certType,
        level: session.level,
        status: session.status,
        startedAt: session.startedAt,
        hardDeadline: session.hardDeadline,
        timing,
      },
      questions: session.answers.map((a) => {
        const snap = a.contentSnapshot as { stem: string; choices: { key: string; text: string }[]; subjectName: string; points: number };
        return {
          questionId: a.questionId,
          orderIndex: a.orderIndex,
          stem: snap.stem,
          choices: snap.choices,
          subjectName: snap.subjectName,
          points: snap.points,
          selectedChoice: a.selectedChoice,
          flagged: a.flagged,
          version: a.version,
        };
      }),
      tasks: tasks.map((t) => ({
        taskId: t.id,
        part: t.part,
        title: t.title,
        scenario: t.scenario,
        durationMin: t.durationMin,
        points: t.points,
        orderIndex: t.orderIndex,
      })),
    };
  }

  async saveAnswer(
    userId: string,
    sessionId: string,
    body: { questionId: string; selectedChoice?: string | null; flagged?: boolean; version: number },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.examSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new NotFoundException();
      if (session.userId !== userId) throw new ForbiddenException();
      if (session.status !== ExamSessionStatus.IN_PROGRESS) throw new BadRequestException('Exam not in progress');
      if (session.hardDeadline && new Date() > session.hardDeadline) throw new BadRequestException('Time over');

      const answer = await tx.answer.findUnique({
        where: { sessionId_questionId: { sessionId, questionId: body.questionId } },
      });
      if (!answer) throw new NotFoundException('Question not in this paper');
      if (answer.version !== body.version) {
        throw new ConflictException({ message: 'Version mismatch', currentVersion: answer.version });
      }
      const updated = await tx.answer.update({
        where: { id: answer.id },
        data: {
          selectedChoice: body.selectedChoice ?? null,
          flagged: body.flagged ?? answer.flagged,
          version: { increment: 1 },
        },
      });
      return { questionId: body.questionId, version: updated.version };
    });
  }
}

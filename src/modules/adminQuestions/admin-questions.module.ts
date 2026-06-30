import { Module } from '@nestjs/common';
import { AdminQuestionsController, AdminTasksController } from './admin-questions.controller';
import { AdminQuestionsService } from './admin-questions.service';
import { PrismaService } from '../../common/prisma.service';

@Module({
  controllers: [AdminQuestionsController, AdminTasksController],
  providers: [AdminQuestionsService, PrismaService],
})
export class AdminQuestionsModule {}

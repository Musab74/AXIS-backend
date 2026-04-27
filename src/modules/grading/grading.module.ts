import { Module } from '@nestjs/common';
import { GradingController } from './grading.controller';
import { GradingService } from './grading.service';
import { PrismaService } from '../../common/prisma.service';

@Module({
  controllers: [GradingController],
  providers: [GradingService, PrismaService],
})
export class GradingModule {}

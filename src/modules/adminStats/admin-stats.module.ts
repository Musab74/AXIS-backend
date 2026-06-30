import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { AdminStatsController } from './admin-stats.controller';
import { AdminStatsService } from './admin-stats.service';

@Module({
  controllers: [AdminStatsController],
  providers: [AdminStatsService, PrismaService],
  exports: [AdminStatsService],
})
export class AdminStatsModule {}

import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { AdminReportsController } from './admin-reports.controller';
import { AdminReportsService } from './admin-reports.service';

@Module({
  controllers: [AdminReportsController],
  providers: [AdminReportsService, PrismaService],
  exports: [AdminReportsService],
})
export class AdminReportsModule {}

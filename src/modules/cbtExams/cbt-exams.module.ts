import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CbtExamsController } from './cbt-exams.controller';
import { CbtExamsService } from './cbt-exams.service';
import { PrismaService } from '../../common/prisma.service';
import { AdminMonitorModule } from '../adminMonitor/admin-monitor.module';

@Module({
  imports: [AdminMonitorModule, ConfigModule],
  controllers: [CbtExamsController],
  providers: [CbtExamsService, PrismaService],
})
export class CbtExamsModule {}

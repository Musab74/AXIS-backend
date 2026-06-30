import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma.service';
import { SnapshotRetentionProcessor } from './snapshot.processor';

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [PrismaService, SnapshotRetentionProcessor],
  exports: [SnapshotRetentionProcessor],
})
export class QueueModule {}

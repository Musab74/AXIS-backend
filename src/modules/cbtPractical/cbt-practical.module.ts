import { Module } from '@nestjs/common';
import { CbtPracticalController } from './cbt-practical.controller';
import { CbtPracticalService } from './cbt-practical.service';
import { PrismaService } from '../../common/prisma.service';
import { AnthropicModule } from '../../integrations/anthropic/anthropic.module';
import { NcObjectStorageModule } from '../../integrations/ncObjectStorage/nc-object-storage.module';
import { AdminMonitorModule } from '../adminMonitor/admin-monitor.module';

@Module({
  imports: [AnthropicModule, NcObjectStorageModule, AdminMonitorModule],
  controllers: [CbtPracticalController],
  providers: [CbtPracticalService, PrismaService],
})
export class CbtPracticalModule {}

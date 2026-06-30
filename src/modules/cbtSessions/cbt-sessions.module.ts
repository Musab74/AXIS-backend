import { Module, forwardRef } from '@nestjs/common';
import { CbtSessionsController } from './cbt-sessions.controller';
import { CbtSessionsService } from './cbt-sessions.service';
import { PrismaService } from '../../common/prisma.service';
import { AdminMonitorModule } from '../adminMonitor/admin-monitor.module';
import { AdminNotificationsModule } from '../adminNotifications/admin-notifications.module';
import { RedisModule } from '../../integrations/redis/redis.module';
import { NcObjectStorageModule } from '../../integrations/ncObjectStorage/nc-object-storage.module';

@Module({
  imports: [forwardRef(() => AdminMonitorModule), AdminNotificationsModule, RedisModule, NcObjectStorageModule],
  controllers: [CbtSessionsController],
  providers: [CbtSessionsService, PrismaService],
  exports: [CbtSessionsService],
})
export class CbtSessionsModule {}

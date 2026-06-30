import { Module, forwardRef } from '@nestjs/common';
import { RedisModule } from '../../integrations/redis/redis.module';
import { AdminMonitorModule } from '../adminMonitor/admin-monitor.module';
import { AdminNotificationsController } from './admin-notifications.controller';
import { AdminNotificationsService } from './admin-notifications.service';

@Module({
  imports: [RedisModule, forwardRef(() => AdminMonitorModule)],
  controllers: [AdminNotificationsController],
  providers: [AdminNotificationsService],
  exports: [AdminNotificationsService],
})
export class AdminNotificationsModule {}

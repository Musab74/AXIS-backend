import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { PrismaService } from '../../common/prisma.service';
import { RedisModule } from '../../integrations/redis/redis.module';
import { WebsocketModule } from '../../websocket/websocket.module';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { AuthSessionModule } from '../auth/auth-session.module';
import { CbtSessionsModule } from '../cbtSessions/cbt-sessions.module';
import { AdminNotificationsModule } from '../adminNotifications/admin-notifications.module';
import { AdminMonitorActionsService } from './admin-monitor-actions.service';
import { AdminMonitorController } from './admin-monitor.controller';
import { AdminMonitorService } from './admin-monitor.service';
import { AdminMonitorGateway } from './admin-monitor.gateway';
import { ExamSessionPauseService } from './exam-session-pause.service';
import { MonitorHeartbeatService } from './monitor-heartbeat.service';
import { MonitorSweeperService } from './monitor-sweeper.service';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({}),
    RedisModule,
    AuthSessionModule,
    WebsocketModule,
    forwardRef(() => CbtSessionsModule),
    forwardRef(() => AdminNotificationsModule),
  ],
  controllers: [AdminMonitorController],
  providers: [
    AdminMonitorService,
    AdminMonitorActionsService,
    AdminMonitorGateway,
    ExamSessionPauseService,
    MonitorHeartbeatService,
    MonitorSweeperService,
    JwtStrategy,
    PrismaService,
  ],
  exports: [
    AdminMonitorService,
    AdminMonitorGateway,
    AdminMonitorActionsService,
    ExamSessionPauseService,
    MonitorHeartbeatService,
  ],
})
export class AdminMonitorModule {}

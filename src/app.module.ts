import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { envConfig } from './config/env.config';
import { envValidationSchema } from './config/env.validation';
import { PrismaService } from './common/prisma.service';
import { NiceAuthModule } from './integrations/niceAuth/nice-auth.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { IdentityVerificationModule } from './modules/identityVerification/identity-verification.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { CbtSessionsModule } from './modules/cbtSessions/cbt-sessions.module';
import { CbtExamsModule } from './modules/cbtExams/cbt-exams.module';
import { CbtPracticalModule } from './modules/cbtPractical/cbt-practical.module';
import { GradingModule } from './modules/grading/grading.module';
import { SchedulesModule } from './modules/schedules/schedules.module';
import { RegistrationsModule } from './modules/registrations/registrations.module';
import { ResultsModule } from './modules/results/results.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DemoModule } from './modules/demo/demo.module';
import { ProctorModule } from './modules/proctor/proctor.module';
import { AdminUsersModule } from './modules/adminUsers/admin-users.module';
import { AdminStatsModule } from './modules/adminStats/admin-stats.module';
import { AdminReportsModule } from './modules/adminReports/admin-reports.module';
import { AdminMonitorModule } from './modules/adminMonitor/admin-monitor.module';
import { AdminQuestionsModule } from './modules/adminQuestions/admin-questions.module';
import { InquiriesModule } from './modules/inquiries/inquiries.module';
import { ContentModule } from './modules/content/content.module';
import { RedisModule } from './integrations/redis/redis.module';
import { WebsocketModule } from './websocket/websocket.module';
import { QueueModule } from './queue/queue.module';
import { CertificatesModule } from './modules/certificates/certificates.module';
import { SandboxModule } from './modules/sandbox/sandbox.module';
import { AdminNotificationsModule } from './modules/adminNotifications/admin-notifications.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [envConfig],
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false, allowUnknown: true },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    RedisModule,
    WebsocketModule,
    QueueModule,
    NiceAuthModule,
    AuthModule,
    UsersModule,
    IdentityVerificationModule,
    PaymentsModule,
    CbtSessionsModule,
    CbtExamsModule,
    CbtPracticalModule,
    GradingModule,
    SchedulesModule,
    RegistrationsModule,
    ResultsModule,
    DashboardModule,
    DemoModule,
    ProctorModule,
    AdminUsersModule,
    AdminStatsModule,
    AdminReportsModule,
    AdminMonitorModule,
    AdminQuestionsModule,
    InquiriesModule,
    ContentModule,
    CertificatesModule,
    SandboxModule,
    AdminNotificationsModule,
  ],
  providers: [
    PrismaService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
  exports: [PrismaService],
})
export class AppModule {}

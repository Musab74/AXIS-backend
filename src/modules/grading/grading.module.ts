import { Module } from '@nestjs/common';
import { GradingController } from './grading.controller';
import { GradingService } from './grading.service';
import { AdminGradingController } from './admin-grading.controller';
import { AdminGradingService } from './admin-grading.service';
import { EssayGradingService } from './essay-grading.service';
import { CodeGradingService } from './code-grading.service';
import { L3PracticalGraderService } from './l3-practical-grader.service';
import { L3AutoFinalizeService } from './l3-autofinalize.service';
import { BaselineGateService } from './baseline-gate.service';
import { SessionAggregateController } from './session-aggregate.controller';
import { SessionAggregateService } from './session-aggregate.service';
import { ClaudeEssayGraderService } from '../../integrations/anthropic/claude-essay-grader.service';
import { PrismaService } from '../../common/prisma.service';
import { AdminMonitorModule } from '../adminMonitor/admin-monitor.module';
import { AdminNotificationsModule } from '../adminNotifications/admin-notifications.module';
import { CertificatesModule } from '../certificates/certificates.module';
import { CbtSessionsModule } from '../cbtSessions/cbt-sessions.module';
import { NcObjectStorageModule } from '../../integrations/ncObjectStorage/nc-object-storage.module';

@Module({
  imports: [AdminMonitorModule, AdminNotificationsModule, CertificatesModule, CbtSessionsModule, NcObjectStorageModule],
  controllers: [GradingController, AdminGradingController, SessionAggregateController],
  providers: [
    GradingService,
    AdminGradingService,
    EssayGradingService,
    CodeGradingService,
    L3PracticalGraderService,
    L3AutoFinalizeService,
    SessionAggregateService,
    BaselineGateService,
    ClaudeEssayGraderService,
    PrismaService,
  ],
  exports: [EssayGradingService, L3PracticalGraderService, SessionAggregateService, BaselineGateService],
})
export class GradingModule {}

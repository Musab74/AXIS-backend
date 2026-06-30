import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AwsRekognitionModule } from '../../integrations/awsRekognition/aws-rekognition.module';
import { GoogleGeminiModule } from '../../integrations/googleGemini/google-gemini.module';
import { AnthropicModule } from '../../integrations/anthropic/anthropic.module';
import { NcObjectStorageModule } from '../../integrations/ncObjectStorage/nc-object-storage.module';
import { WebsocketModule } from '../../websocket/websocket.module';
import { AdminMonitorModule } from '../adminMonitor/admin-monitor.module';
import { CbtSessionsModule } from '../cbtSessions/cbt-sessions.module';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { AuthSessionModule } from '../auth/auth-session.module';
import { PrismaService } from '../../common/prisma.service';
import { ProctorController } from './proctor.controller';
import { FaceReferenceService } from './face-reference.service';
import { AiProctorService } from './ai-proctor.service';
import {
  AdminAiEvidenceController,
  AiProctorController,
} from './ai-proctor.controller';
import { LocalEvidenceController } from './local-evidence.controller';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({}),
    AwsRekognitionModule,
    GoogleGeminiModule,
    AnthropicModule,
    NcObjectStorageModule,
    WebsocketModule,
    AdminMonitorModule,
    // Needed so AiProctorService can call cbtSessions.recordSystemProctorEvent
    // when Gemini/Claude confirms a phone (PHONE_DETECTED strike).
    CbtSessionsModule,
    AuthSessionModule,
  ],
  controllers: [
    ProctorController,
    AiProctorController,
    AdminAiEvidenceController,
    LocalEvidenceController,
  ],
  providers: [JwtStrategy, PrismaService, FaceReferenceService, AiProctorService],
  exports: [FaceReferenceService, AiProctorService],
})
export class ProctorModule {}

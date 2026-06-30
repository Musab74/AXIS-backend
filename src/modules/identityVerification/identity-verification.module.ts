import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ClovaOcrModule } from '../../integrations/clovaOcr/clova-ocr.module';
import { AwsRekognitionModule } from '../../integrations/awsRekognition/aws-rekognition.module';
import { PrismaService } from '../../common/prisma.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { AuthSessionModule } from '../auth/auth-session.module';
import { ProctorModule } from '../proctor/proctor.module';
import { IdentityVerificationController } from './identity-verification.controller';
import { IdentityVerificationService } from './identity-verification.service';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({}),
    ClovaOcrModule,
    AwsRekognitionModule,
    ProctorModule,
    AuthSessionModule,
  ],
  controllers: [IdentityVerificationController],
  providers: [IdentityVerificationService, PrismaService, JwtStrategy],
  exports: [IdentityVerificationService],
})
export class IdentityVerificationModule {}

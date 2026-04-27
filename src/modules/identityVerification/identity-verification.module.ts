import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { UpstageModule } from '../../integrations/upstage/upstage.module';
import { AwsRekognitionModule } from '../../integrations/awsRekognition/aws-rekognition.module';
import { PrismaService } from '../../common/prisma.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { IdentityVerificationController } from './identity-verification.controller';
import { IdentityVerificationService } from './identity-verification.service';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({}),
    UpstageModule,
    AwsRekognitionModule,
  ],
  controllers: [IdentityVerificationController],
  providers: [IdentityVerificationService, PrismaService, JwtStrategy],
  exports: [IdentityVerificationService],
})
export class IdentityVerificationModule {}

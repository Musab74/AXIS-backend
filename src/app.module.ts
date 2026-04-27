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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [envConfig],
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false, allowUnknown: true },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    NiceAuthModule,
    AuthModule,
    UsersModule,
    IdentityVerificationModule,
    PaymentsModule,
    CbtSessionsModule,
    CbtExamsModule,
    CbtPracticalModule,
    GradingModule,
  ],
  providers: [
    PrismaService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
  exports: [PrismaService],
})
export class AppModule {}

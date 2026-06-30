import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginAuditService } from './login-audit.service';
import { AuthSessionModule } from './auth-session.module';
import { JwtStrategy } from './strategies/jwt.strategy';
import { PrismaService } from '../../common/prisma.service';
import { NiceAuthModule } from '../../integrations/niceAuth/nice-auth.module';
import { RedisModule } from '../../integrations/redis/redis.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({}),
    NiceAuthModule,
    UsersModule,
    AuthSessionModule,
    RedisModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, LoginAuditService, JwtStrategy, PrismaService],
  exports: [AuthService, AuthSessionModule, LoginAuditService],
})
export class AuthModule {}

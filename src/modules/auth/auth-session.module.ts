import { Module } from '@nestjs/common';
import { RedisModule } from '../../integrations/redis/redis.module';
import { AuthSessionService } from './auth-session.service';

@Module({
  imports: [RedisModule],
  providers: [AuthSessionService],
  exports: [AuthSessionService],
})
export class AuthSessionModule {}

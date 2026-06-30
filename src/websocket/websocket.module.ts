import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaService } from '../common/prisma.service';
import { RedisModule } from '../integrations/redis/redis.module';
import { AdminGateway } from './admin.gateway';
import { ExamSessionGateway } from './exam-session.gateway';

@Module({
  imports: [JwtModule.register({}), RedisModule],
  providers: [AdminGateway, ExamSessionGateway, PrismaService],
  exports: [AdminGateway, ExamSessionGateway],
})
export class WebsocketModule {}

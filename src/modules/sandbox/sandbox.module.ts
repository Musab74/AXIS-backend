import { Module } from '@nestjs/common';
import { SandboxController } from './sandbox.controller';
import { SandboxService } from './sandbox.service';
import { PrismaService } from '../../common/prisma.service';
import { Judge0Module } from '../../integrations/judge0/judge0.module';
import { RedisModule } from '../../integrations/redis/redis.module';

@Module({
  imports: [Judge0Module, RedisModule],
  controllers: [SandboxController],
  providers: [SandboxService, PrismaService],
})
export class SandboxModule {}

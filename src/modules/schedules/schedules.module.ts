import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { RedisModule } from '../../integrations/redis/redis.module';
import { AdminSchedulesController, ScheduleApiController, SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';

@Module({
  imports: [RedisModule],
  controllers: [SchedulesController, ScheduleApiController, AdminSchedulesController],
  providers: [SchedulesService, PrismaService],
  exports: [SchedulesService],
})
export class SchedulesModule {}

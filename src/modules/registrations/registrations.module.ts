import { Module, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { RedisModule } from '../../integrations/redis/redis.module';
import { NcObjectStorageModule } from '../../integrations/ncObjectStorage/nc-object-storage.module';
import { PaymentsModule } from '../payments/payments.module';
import { SchedulesModule } from '../schedules/schedules.module';
import {
  AdminRegistrationsController,
  RegistrationsController,
} from './registrations.controller';
import { RegistrationsService } from './registrations.service';
import { RegistrationExpiryService } from './registration-expiry.service';

@Module({
  imports: [
    PaymentsModule,
    NcObjectStorageModule,
    RedisModule,
    forwardRef(() => SchedulesModule),
  ],
  controllers: [RegistrationsController, AdminRegistrationsController],
  providers: [RegistrationsService, RegistrationExpiryService, PrismaService],
  exports: [RegistrationsService],
})
export class RegistrationsModule {}

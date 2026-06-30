import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { RedisModule } from '../../integrations/redis/redis.module';
import { RegistrationsModule } from '../registrations/registrations.module';
import { ResultsModule } from '../results/results.module';
import { UsersModule } from '../users/users.module';
import { CertificatesModule } from '../certificates/certificates.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [UsersModule, RegistrationsModule, ResultsModule, CertificatesModule, RedisModule],
  controllers: [DashboardController],
  providers: [DashboardService, PrismaService],
})
export class DashboardModule {}

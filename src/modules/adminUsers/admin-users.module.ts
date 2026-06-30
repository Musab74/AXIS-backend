import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { RedisModule } from '../../integrations/redis/redis.module';
import { CertificatesModule } from '../certificates/certificates.module';
import { AuthModule } from '../auth/auth.module';
import {
  AdminExamineesController,
  AdminUsersController,
} from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

@Module({
  imports: [CertificatesModule, RedisModule, AuthModule],
  controllers: [AdminUsersController, AdminExamineesController],
  providers: [AdminUsersService, PrismaService],
  exports: [AdminUsersService],
})
export class AdminUsersModule {}

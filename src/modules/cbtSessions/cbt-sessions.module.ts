import { Module } from '@nestjs/common';
import { CbtSessionsController } from './cbt-sessions.controller';
import { CbtSessionsService } from './cbt-sessions.service';
import { PrismaService } from '../../common/prisma.service';

@Module({
  controllers: [CbtSessionsController],
  providers: [CbtSessionsService, PrismaService],
  exports: [CbtSessionsService],
})
export class CbtSessionsModule {}

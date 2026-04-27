import { Module } from '@nestjs/common';
import { CbtExamsController } from './cbt-exams.controller';
import { CbtExamsService } from './cbt-exams.service';
import { PrismaService } from '../../common/prisma.service';

@Module({
  controllers: [CbtExamsController],
  providers: [CbtExamsService, PrismaService],
})
export class CbtExamsModule {}

import { Module } from '@nestjs/common';
import { CbtPracticalController } from './cbt-practical.controller';
import { CbtPracticalService } from './cbt-practical.service';
import { PrismaService } from '../../common/prisma.service';

@Module({
  controllers: [CbtPracticalController],
  providers: [CbtPracticalService, PrismaService],
})
export class CbtPracticalModule {}

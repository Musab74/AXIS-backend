import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';

@Module({
  controllers: [DemoController],
  providers: [DemoService, PrismaService],
})
export class DemoModule {}

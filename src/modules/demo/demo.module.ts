import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { AnthropicModule } from '../../integrations/anthropic/anthropic.module';
import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';

@Module({
  imports: [AnthropicModule],
  controllers: [DemoController],
  providers: [DemoService, PrismaService],
})
export class DemoModule {}

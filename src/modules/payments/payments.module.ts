import { Module } from '@nestjs/common';
import { TossPaymentsModule } from '../../integrations/tossPayments/toss-payments.module';
import { PrismaService } from '../../common/prisma.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [TossPaymentsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PrismaService],
  exports: [PaymentsService],
})
export class PaymentsModule {}

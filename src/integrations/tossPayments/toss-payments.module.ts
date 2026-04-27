import { Module } from '@nestjs/common';
import { TossPaymentsService } from './toss-payments.service';

@Module({
  providers: [TossPaymentsService],
  exports: [TossPaymentsService],
})
export class TossPaymentsModule {}

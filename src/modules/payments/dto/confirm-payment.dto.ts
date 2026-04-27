import { IsInt, IsString, Matches, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ConfirmPaymentDto {
  @ApiProperty({ description: 'paymentKey returned by Toss after user authorization' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,200}$/, { message: 'invalid paymentKey format' })
  paymentKey!: string;

  @ApiProperty({ description: 'Server-issued orderId echoed back by Toss' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{6,64}$/, { message: 'invalid orderId format' })
  orderId!: string;

  @ApiProperty({ description: 'Amount in KRW (will be cross-checked against server record)' })
  @IsInt()
  @Min(100)
  @Max(10_000_000)
  amount!: number;
}

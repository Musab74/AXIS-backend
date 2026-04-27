import { IsOptional, IsInt, IsString, Length, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefundPaymentDto {
  @ApiProperty({ description: 'Reason shown to Toss / receipt', minLength: 2 })
  @IsString()
  @Length(2, 200)
  reason!: string;

  @ApiProperty({ description: 'Optional partial-refund amount in KRW; full refund if omitted', required: false })
  @IsOptional()
  @IsInt()
  @Min(100)
  amount?: number;
}

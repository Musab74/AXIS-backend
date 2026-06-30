import { IsString, MinLength } from 'class-validator';

export class PortoneApplyConfirmDto {
  @IsString()
  @MinLength(1)
  paymentId!: string;

  @IsString()
  @MinLength(1)
  merchantId!: string;
}

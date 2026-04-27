import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ReadyPaymentDto {
  @ApiProperty({ description: 'Registration ID to pay for' })
  @IsString()
  @Length(1, 64)
  registrationId!: string;
}

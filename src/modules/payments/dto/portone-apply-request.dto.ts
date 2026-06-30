import { IsString, MinLength } from 'class-validator';

export class PortoneApplyRequestDto {
  @IsString()
  @MinLength(10)
  registrationId!: string;
}

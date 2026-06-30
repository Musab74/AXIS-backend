import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class GrantAttemptDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason?: string;
}

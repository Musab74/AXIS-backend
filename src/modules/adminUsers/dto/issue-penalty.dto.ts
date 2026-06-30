import { IsString, IsDateString, IsOptional, MinLength } from 'class-validator';

export class IssuePenaltyDto {
  @IsString()
  @MinLength(10)
  reason!: string;

  @IsDateString()
  startAt!: string;

  @IsDateString()
  endAt!: string;

  @IsOptional()
  @IsString()
  relatedSessionId?: string;
}

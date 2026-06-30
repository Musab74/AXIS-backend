import { IsString, MinLength } from 'class-validator';

export class ReleasePenaltyDto {
  @IsString()
  @MinLength(5)
  releaseReason!: string;
}

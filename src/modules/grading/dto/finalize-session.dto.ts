import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class FinalizeTaskScoreDto {
  @IsString()
  taskId!: string;

  /**
   * Expert score for this practical / essay task. Range is the points the task
   * is worth (0..task.points). Service-side validation enforces the upper
   * bound against `TaskTemplate.points`.
   */
  @IsInt()
  @Min(0)
  @Max(100)
  expertScore!: number;

  @IsOptional()
  @IsString()
  expertNotes?: string;

  @IsOptional()
  @IsIn(['accepted', 'rejected'])
  deliverableReview?: 'accepted' | 'rejected';
}

export class FinalizeSessionDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FinalizeTaskScoreDto)
  tasks!: FinalizeTaskScoreDto[];

  /** Optional override for the displayed fail reason (defaults to auto-generated). */
  @IsOptional()
  @IsString()
  failReason?: string;
}

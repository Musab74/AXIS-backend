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

export class ExpertTaskScoreDto {
  @IsString()
  taskId!: string;

  /**
   * Expert's score for this practical / essay task.
   * Range: 0 to the task's max points (enforced service-side against TaskTemplate.points).
   */
  @IsInt()
  @Min(0)
  @Max(100)
  expertScore!: number;

  @IsOptional()
  @IsString()
  expertNotes?: string;

  /** L1 deliverable proof accept/deny — stored in expertNotes marker, no DB migration. */
  @IsOptional()
  @IsIn(['accepted', 'rejected'])
  deliverableReview?: 'accepted' | 'rejected';
}

/**
 * DTO for `PATCH /admin/grading/sessions/:id/expert-score`.
 * Saves first-expert scores WITHOUT finalising the session — the session
 * stays SUBMITTED so a second expert or grading admin can review and finalize.
 */
export class ExpertScoreDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ExpertTaskScoreDto)
  tasks!: ExpertTaskScoreDto[];
}

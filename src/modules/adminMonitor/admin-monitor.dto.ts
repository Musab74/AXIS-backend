import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class MonitorWarnDto {
  @ApiPropertyOptional({ description: 'Warning message shown to the candidate' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}

export class MonitorPauseDto {
  @ApiPropertyOptional({ description: 'Reason for pausing (shown to candidate)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class MonitorExtendDto {
  @ApiPropertyOptional({ description: 'Seconds to add to hardDeadline (60–3600)' })
  @IsInt()
  @Min(60)
  @Max(3600)
  seconds!: number;
}

export class MonitorTerminateDto {
  @ApiPropertyOptional({ description: 'Reason recorded in audit log' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

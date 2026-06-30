import { IsEnum, IsOptional, IsDateString } from 'class-validator';
import { CertLevel, CertType } from '@prisma/client';

export class StatsFilterDto {
  @IsOptional()
  @IsEnum(CertType)
  certType?: CertType;

  @IsOptional()
  @IsEnum(CertLevel)
  level?: CertLevel;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

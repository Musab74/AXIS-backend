import { IsString, IsEnum, IsBoolean, IsInt, IsOptional } from 'class-validator';
import { FaqCategory } from '@prisma/client';

export class UpdateFaqDto {
  @IsEnum(FaqCategory)
  @IsOptional()
  category?: FaqCategory;

  @IsString()
  @IsOptional()
  question?: string;

  @IsString()
  @IsOptional()
  answer?: string;

  @IsInt()
  @IsOptional()
  sortOrder?: number;

  @IsBoolean()
  @IsOptional()
  pinned?: boolean;

  @IsBoolean()
  @IsOptional()
  published?: boolean;
}

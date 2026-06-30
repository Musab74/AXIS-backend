import { IsString, IsEnum, IsBoolean, IsInt, IsOptional } from 'class-validator';
import { FaqCategory } from '@prisma/client';

export class CreateFaqDto {
  @IsEnum(FaqCategory)
  @IsOptional()
  category?: FaqCategory;

  @IsString()
  question: string;

  @IsString()
  answer: string;

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

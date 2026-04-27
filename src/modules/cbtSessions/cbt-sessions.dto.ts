import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { CertType, CertLevel } from '@prisma/client';

export class CreateSessionDto {
  @IsEnum(CertType)
  certType!: CertType;

  @IsEnum(CertLevel)
  level!: CertLevel;
}

export class SaveAnswerDto {
  @IsString()
  questionId!: string;

  @IsOptional()
  @IsString()
  selectedChoice?: string | null;

  @IsOptional()
  flagged?: boolean;

  @IsInt()
  @Min(0)
  version!: number;
}

export class SavePracticalDto {
  @IsString()
  taskId!: string;

  @IsString()
  contentText!: string;

  @IsOptional()
  aiChatLog?: { role: 'user' | 'assistant'; text: string; ts: number }[];

  @IsInt()
  @Min(0)
  version!: number;
}

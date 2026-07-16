import { IsString, IsEnum, IsBoolean, IsOptional, IsNotEmpty, MaxLength } from 'class-validator';
import { NoticeTagType, NoticeStatus } from '@prisma/client';

export class CreateNoticeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  tag: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  tagEn?: string;

  @IsEnum(NoticeTagType)
  @IsOptional()
  tagType?: NoticeTagType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  titleEn?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  content: string;

  @IsString()
  @IsOptional()
  @MaxLength(20000)
  contentEn?: string;

  @IsEnum(NoticeStatus)
  @IsOptional()
  status?: NoticeStatus;

  @IsBoolean()
  @IsOptional()
  pinned?: boolean;
}

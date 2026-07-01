import { IsString, IsEnum, IsBoolean, IsOptional } from 'class-validator';
import { NoticeTagType, NoticeStatus } from '@prisma/client';

export class UpdateNoticeDto {
  @IsString()
  @IsOptional()
  tag?: string;

  @IsString()
  @IsOptional()
  tagEn?: string;

  @IsEnum(NoticeTagType)
  @IsOptional()
  tagType?: NoticeTagType;

  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  titleEn?: string;

  @IsString()
  @IsOptional()
  content?: string;

  @IsString()
  @IsOptional()
  contentEn?: string;

  @IsEnum(NoticeStatus)
  @IsOptional()
  status?: NoticeStatus;

  @IsBoolean()
  @IsOptional()
  pinned?: boolean;
}

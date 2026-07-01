import { IsString, IsEnum, IsBoolean, IsOptional } from 'class-validator';
import { NoticeTagType, NoticeStatus } from '@prisma/client';

export class CreateNoticeDto {
  @IsString()
  tag: string;

  @IsString()
  @IsOptional()
  tagEn?: string;

  @IsEnum(NoticeTagType)
  @IsOptional()
  tagType?: NoticeTagType;

  @IsString()
  title: string;

  @IsString()
  @IsOptional()
  titleEn?: string;

  @IsString()
  content: string;

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

import { IsString, IsEnum, IsBoolean, IsOptional } from 'class-validator';
import { NoticeTagType, NoticeStatus } from '@prisma/client';

export class CreateNoticeDto {
  @IsString()
  tag: string;

  @IsEnum(NoticeTagType)
  @IsOptional()
  tagType?: NoticeTagType;

  @IsString()
  title: string;

  @IsString()
  content: string;

  @IsEnum(NoticeStatus)
  @IsOptional()
  status?: NoticeStatus;

  @IsBoolean()
  @IsOptional()
  pinned?: boolean;
}

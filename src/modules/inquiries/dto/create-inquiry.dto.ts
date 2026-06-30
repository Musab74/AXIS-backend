import { InquiryCategory } from '@prisma/client';
import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateInquiryDto {
  @IsEnum(InquiryCategory)
  category!: InquiryCategory;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @IsString()
  @IsNotEmpty()
  content!: string;
}

export class CreateReplyDto {
  @IsString()
  @IsNotEmpty()
  content!: string;
}

import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateNotificationPreferencesDto {
  @IsOptional() @IsBoolean()
  examStart?: boolean;

  @IsOptional() @IsBoolean()
  examFinish?: boolean;

  @IsOptional() @IsBoolean()
  cheating?: boolean;

  @IsOptional() @IsBoolean()
  inquiry?: boolean;

  @IsOptional() @IsBoolean()
  inquiryReply?: boolean;

  @IsOptional() @IsBoolean()
  grading?: boolean;

  @IsOptional() @IsBoolean()
  registration?: boolean;
}

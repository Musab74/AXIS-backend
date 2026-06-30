import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CertType } from '@prisma/client';

/**
 * Admin-created EXPERT grader account. Unlike candidate signup this skips NICE
 * 본인인증 (staff accounts are vouched for by the admin), so the admin supplies
 * the login id, password, and profile directly, plus the series the expert is
 * allowed to grade.
 */
export class CreateExpertDto {
  /** Login id the expert will use on the admin panel. Admin chooses it. */
  @IsString()
  @Matches(/^[a-zA-Z0-9_.-]{4,30}$/, {
    message: '아이디는 영문/숫자/._- 4~30자여야 합니다',
  })
  userId!: string;

  @IsString()
  @MinLength(8, { message: '비밀번호는 8자 이상이어야 합니다' })
  @MaxLength(72)
  password!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name!: string;

  @IsString()
  @Matches(/^[0-9-]{9,20}$/, { message: '유효한 연락처를 입력하세요' })
  phone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  email?: string;

  /** Series the expert may grade. A coding expert gets [AXIS_C], etc. */
  @IsArray()
  @ArrayNotEmpty({ message: '담당 분야를 1개 이상 선택하세요' })
  @ArrayUnique()
  @IsEnum(CertType, { each: true })
  competencies!: CertType[];
}

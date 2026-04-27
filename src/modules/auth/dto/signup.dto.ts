import { IsString, MinLength, MaxLength, Matches, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SignupDto {
  @ApiProperty({
    description: '로그인용 사용자 ID (영문+숫자, 4-20자)',
    example: 'testuser01',
  })
  @IsString()
  @MinLength(4)
  @MaxLength(20)
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'userId는 영문, 숫자, 밑줄(_)만 사용 가능합니다',
  })
  userId!: string;

  @ApiProperty({
    description: '비밀번호 (8자 이상, 영문+숫자+특수문자)',
    example: 'MyPass123!',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(50)
  @Matches(/^(?=.*[a-zA-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/, {
    message: '비밀번호는 영문, 숫자, 특수문자를 포함해야 합니다',
  })
  password!: string;

  @ApiProperty({
    description: 'NICE 인증 세션 ID (본인인증 완료 후 받은 값)',
    example: 'clxxxxxxxxxxxxxxxxx',
  })
  @IsString()
  niceSessionId!: string;

  @ApiProperty({
    description: '이메일 (선택)',
    example: 'user@example.com',
    required: false,
  })
  @IsString()
  @IsOptional()
  email?: string;

  @ApiProperty({
    description: '개인정보 수집·이용 동의',
    example: true,
  })
  @IsBoolean()
  agreePrivacy!: boolean;

  @ApiProperty({
    description: '서비스 이용약관 동의',
    example: true,
  })
  @IsBoolean()
  agreeTerms!: boolean;

  @ApiProperty({
    description: '마케팅 수신 동의 (선택)',
    example: false,
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  agreeMarketing?: boolean;
}

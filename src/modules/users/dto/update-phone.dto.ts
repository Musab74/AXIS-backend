import { IsString, Matches, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdatePhoneDto {
  @ApiProperty({
    description: 'NICE 본인인증 세션 ID (인증 완료 후 발급)',
    example: 'clxxxxxxxxxxxxxxxxx',
  })
  @IsString()
  @MinLength(10)
  niceSessionId!: string;

  @ApiProperty({
    description: '변경할 휴대전화 번호 (숫자만, 10~11자리)',
    example: '01012345678',
  })
  @IsString()
  @Matches(/^\d{10,11}$/, { message: '휴대전화 번호 형식이 올바르지 않습니다' })
  phone!: string;
}

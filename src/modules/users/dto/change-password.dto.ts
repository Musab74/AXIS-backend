import { IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto {
  @ApiProperty({ description: '현재 비밀번호' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  currentPassword!: string;

  @ApiProperty({
    description: '새 비밀번호 (8자 이상, 영문+숫자+특수문자)',
    example: 'NewPass123!',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(50)
  @Matches(/^(?=.*[a-zA-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/, {
    message: '비밀번호는 영문, 숫자, 특수문자를 포함해야 합니다',
  })
  newPassword!: string;
}

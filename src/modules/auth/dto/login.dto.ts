import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({
    description: '사용자 ID',
    example: 'testuser01',
  })
  @IsString()
  userId!: string;

  @ApiProperty({
    description: '비밀번호',
    example: 'MyPass123!',
  })
  @IsString()
  password!: string;
}

import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class NiceRequestDto {
  @ApiProperty({
    description: '인증 방식',
    enum: ['CHECKPLUS', 'IPIN'],
    example: 'CHECKPLUS',
  })
  @IsEnum(['CHECKPLUS', 'IPIN'])
  authType!: 'CHECKPLUS' | 'IPIN';

  @ApiProperty({
    description: '인증 완료 후 리다이렉트 URL (프론트엔드)',
    example: 'http://localhost:5173/auth/nice/callback',
    required: false,
  })
  @IsString()
  @IsOptional()
  returnUrl?: string;
}

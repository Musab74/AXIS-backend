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
    description:
      'Optional (ignored for RTN_URL). NICE return URL is fixed server-side: {APP_URL}/auth/nice/checkplus-return or ipin-return — register that URL in NICE admin.',
    example: 'http://localhost:5173/',
    required: false,
  })
  @IsString()
  @IsOptional()
  returnUrl?: string;
}

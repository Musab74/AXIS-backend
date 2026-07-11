import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RevealPiiDto {
  @ApiProperty({
    description: '열람 사유 (감사 로그에 저장됩니다)',
    example: '환불 처리를 위한 본인 연락',
  })
  @IsString()
  @MinLength(2, { message: '열람 사유를 입력해주세요' })
  @MaxLength(500)
  reason!: string;
}

import { IsEnum, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class NiceCallbackDto {
  @ApiProperty({ description: 'NICE 암호화 응답 데이터' })
  @IsString()
  encData!: string;

  @ApiProperty({
    description: '인증 방식',
    enum: ['CHECKPLUS', 'IPIN'],
  })
  @IsEnum(['CHECKPLUS', 'IPIN'])
  authType!: 'CHECKPLUS' | 'IPIN';

  @ApiProperty({ description: '요청 번호 (검증용)' })
  @IsString()
  requestNo!: string;
}

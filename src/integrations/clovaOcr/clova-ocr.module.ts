import { Module } from '@nestjs/common';
import { ClovaOcrService } from './clova-ocr.service';

@Module({
  providers: [ClovaOcrService],
  exports: [ClovaOcrService],
})
export class ClovaOcrModule {}

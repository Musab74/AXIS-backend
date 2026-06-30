import { Module } from '@nestjs/common';
import { GeminiVisionService } from './google-gemini.service';

@Module({
  providers: [GeminiVisionService],
  exports: [GeminiVisionService],
})
export class GoogleGeminiModule {}

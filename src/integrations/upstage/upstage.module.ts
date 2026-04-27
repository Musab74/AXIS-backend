import { Module } from '@nestjs/common';
import { UpstageService } from './upstage.service';

@Module({
  providers: [UpstageService],
  exports: [UpstageService],
})
export class UpstageModule {}

import { Module } from '@nestjs/common';
import { NiceAuthService } from './nice-auth.service';

@Module({
  providers: [NiceAuthService],
  exports: [NiceAuthService],
})
export class NiceAuthModule {}

import { Module } from '@nestjs/common';
import { NcObjectStorageService } from './nc-object-storage.service';

@Module({
  providers: [NcObjectStorageService],
  exports: [NcObjectStorageService],
})
export class NcObjectStorageModule {}

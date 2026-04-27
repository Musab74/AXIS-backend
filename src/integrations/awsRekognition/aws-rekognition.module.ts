import { Module } from '@nestjs/common';
import { AwsRekognitionService } from './aws-rekognition.service';

@Module({
  providers: [AwsRekognitionService],
  exports: [AwsRekognitionService],
})
export class AwsRekognitionModule {}

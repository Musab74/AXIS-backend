import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { CertificatesModule } from '../certificates/certificates.module';
import { PublicResultsController } from './public-results.controller';
import { ResultsController } from './results.controller';
import { ResultsService } from './results.service';

@Module({
  imports: [CertificatesModule],
  controllers: [ResultsController, PublicResultsController],
  providers: [ResultsService, PrismaService],
  exports: [ResultsService],
})
export class ResultsModule {}

import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';

@Module({
  controllers: [CertificatesController],
  providers: [CertificatesService, PrismaService],
  exports: [CertificatesService],
})
export class CertificatesModule {}

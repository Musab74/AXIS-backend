import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Param,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { CertificatesService } from './certificates.service';

@ApiTags('Certificates')
@Controller('certificates')
export class CertificatesController {
  private readonly log = new Logger(CertificatesController.name);

  constructor(private readonly svc: CertificatesService) {}

  @Public()
  @Get('verify/:certNumber')
  @ApiOperation({ summary: 'Public certificate authenticity check (cert number + holder)' })
  verify(
    @Param('certNumber') certNumber: string,
    @Query('holderName') holderName?: string,
  ) {
    const holder = holderName?.trim() ?? '';
    if (holder.length < 2) {
      throw new BadRequestException('holderName must be at least 2 characters');
    }
    const verify = this.svc.verifyPublic;
    if (typeof verify !== 'function') {
      this.log.error('CertificatesService.verifyPublic missing — dist reload race or stale deploy; restart backend');
      throw new ServiceUnavailableException(
        'Verification is temporarily unavailable. Please retry in a few seconds.',
      );
    }
    return verify.call(this.svc, certNumber, holder);
  }
}

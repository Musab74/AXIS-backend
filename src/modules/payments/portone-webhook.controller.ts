/**
 * PORTONE WEBHOOK REGISTRATION
 * After deploying, register this URL in PortOne console:
 * admin.portone.io → 결제 연동 → Payment Notification (Webhook) Management
 * → Add URL: https://axisexam.com/api/webhooks/portone
 *
 * For local testing use ngrok:
 * ngrok http 3333
 * → Register: https://xxxxx.ngrok.io/api/webhooks/portone
 *
 * Events to subscribe:
 * - Transaction.Paid
 * - Transaction.Cancelled
 * - Transaction.Failed
 * - Transaction.VirtualAccountIssued
 */
import {
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { PortoneApplyService } from './portone-apply.service';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@ApiTags('Webhooks')
@Controller('webhooks')
export class PortoneWebhookController {
  constructor(private readonly portoneApply: PortoneApplyService) {}

  @Public()
  @Post('portone')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'PortOne V2 webhook (signature verified)' })
  async portone(@Req() req: RawBodyRequest) {
    const raw = req.rawBody;
    if (!raw || !raw.length) throw new ForbiddenException('Missing raw body');
    const utf8 = raw.toString('utf8');
    await this.portoneApply.verifyAndHandleWebhookPayload(
      utf8,
      req.headers as Record<string, string | string[] | undefined>,
    );
    return { ok: true };
  }
}

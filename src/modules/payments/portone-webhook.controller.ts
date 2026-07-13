/**
 * PORTONE WEBHOOK REGISTRATION — V2 (active, PORTONE_MODULE_VERSION=v2)
 * Registered in PortOne console (admin.portone.io → 결제 연동(V2) → 웹훅 관리):
 *   https://axisexam.com/api/webhooks/portone   (Content-Type: application/json)
 * — Apache strips /api and forwards to Nest's /webhooks/portone
 * (https://api.axisexam.com/webhooks/portone also works). Copy the endpoint's
 * webhook secret (whsec_...) into PORTONE_WEBHOOK_SECRET — V2 webhooks are
 * signed (standard-webhooks) and PortoneV2Gateway.verifyWebhook rejects any
 * payload whose signature does not match.
 *
 * Events to subscribe (V2 console):
 * - Transaction.Paid
 * - Transaction.Cancelled
 * - Transaction.Failed
 * - Transaction.VirtualAccountIssued
 *
 * NOTE: PortOne only auto-retries webhooks on network error / 5xx — a 4xx
 * response is silently dropped, which is why PaymentsReconciliationService
 * sweeps PENDING payments as a backstop.
 *
 * For local testing use ngrok:
 * ngrok http 3333
 * → Register: https://xxxxx.ngrok.io/webhooks/portone
 *
 * LEGACY V1 (PORTONE_MODULE_VERSION=v1 fallback only): register the same URL
 * under 결제모듈 V1 → 웹훅 관리, in BOTH 테스트 and 실연동 modes — PortOne
 * keeps them separate. V1 callbacks are UNSIGNED; the console's 호출 테스트
 * must return 200 (403 = the old rawBody bug is still deployed).
 *
 * SECURITY: webhook bodies are untrusted triggers — every event is re-fetched
 * from the PG API before any DB state changes (see PortoneApplyService
 * .reconcileFromRemote). Optionally set PORTONE_WEBHOOK_ALLOWED_IPS to pin
 * the PG's documented source IPs as defence-in-depth.
 */
import {
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { getRequestClientIp } from '../../common/utils/client-ip.util';
import { PortoneApplyService } from './portone-apply.service';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@ApiTags('Webhooks')
@Controller('webhooks')
export class PortoneWebhookController {
  private readonly logger = new Logger(PortoneWebhookController.name);

  constructor(
    private readonly portoneApply: PortoneApplyService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('portone')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'PortOne webhook (verified via PG API re-fetch)' })
  async portone(@Req() req: RawBodyRequest) {
    this.assertSourceIpAllowed(req);
    const raw = req.rawBody;
    if (!raw || !raw.length) throw new ForbiddenException('Missing raw body');
    const utf8 = raw.toString('utf8');
    await this.portoneApply.verifyAndHandleWebhookPayload(
      utf8,
      req.headers as Record<string, string | string[] | undefined>,
    );
    return { ok: true };
  }

  /**
   * Optional defence-in-depth: when PORTONE_WEBHOOK_ALLOWED_IPS is set
   * (comma-separated), reject webhooks from any other source IP. Requires the
   * edge proxy to forward the real client IP in X-Forwarded-For. Left empty,
   * no IP check runs — state changes are already gated on PG API re-fetch.
   */
  private assertSourceIpAllowed(req: RawBodyRequest): void {
    const allowed = (this.config.get<string>('portone.webhookAllowedIps') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allowed.length) return;
    const ip = getRequestClientIp(req);
    if (!allowed.includes(ip)) {
      this.logger.warn(`PortOne webhook rejected: source ip=${ip} not in allowlist`);
      throw new ForbiddenException('Webhook source IP not allowed');
    }
  }
}

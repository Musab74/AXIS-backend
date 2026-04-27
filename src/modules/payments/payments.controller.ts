import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';
import { ReadyPaymentDto } from './dto/ready-payment.dto';
import { RefundPaymentDto } from './dto/refund-payment.dto';
import { PaymentsService } from './payments.service';
import { TossPaymentsService } from '../../integrations/tossPayments/toss-payments.service';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly toss: TossPaymentsService,
  ) {}

  @Post('ready')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Issue server-side order for browser SDK' })
  ready(@CurrentUser('id') userId: string, @Body() dto: ReadyPaymentDto) {
    return this.payments.ready(userId, dto.registrationId);
  }

  @Post('confirm')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Confirm Toss payment after redirect' })
  confirm(@CurrentUser('id') userId: string, @Body() dto: ConfirmPaymentDto) {
    return this.payments.confirm(userId, dto);
  }

  @Post(':id/refund')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: 'Refund a confirmed payment' })
  refund(
    @CurrentUser('id') userId: string,
    @Param('id') paymentId: string,
    @Body() dto: RefundPaymentDto,
  ) {
    return this.payments.refund(userId, paymentId, dto.reason, dto.amount);
  }

  /**
   * Toss webhook. Public route, but locked down by HMAC signature on the raw body.
   * Body parsing must preserve the raw bytes — see main.ts (rawBody: true).
   */
  @Public()
  @Post('webhook/toss')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Toss webhook (HMAC verified)' })
  async webhook(@Req() req: RawBodyRequest) {
    const signature =
      (req.headers['toss-payments-signature'] as string | undefined) ??
      (req.headers['tosspayments-signature'] as string | undefined) ??
      (req.headers['x-toss-signature'] as string | undefined);

    const raw = req.rawBody;
    if (!raw || !raw.length) throw new ForbiddenException('Missing raw body');

    const ok = this.toss.verifyWebhookSignature(raw, signature);
    if (!ok) throw new ForbiddenException('Invalid signature');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new ForbiddenException('Invalid payload');
    }

    await this.payments.handleVerifiedWebhook(
      parsed as { eventType?: string; data?: never },
    );
    return { ok: true };
  }
}

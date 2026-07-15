import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PortoneApplyConfirmDto } from './dto/portone-apply-confirm.dto';
import { PortoneApplyRequestDto } from './dto/portone-apply-request.dto';
import { PortoneApplyService } from './portone-apply.service';

@ApiTags('Payment (PortOne apply)')
@Controller('payment')
export class ApplyPaymentController {
  constructor(private readonly portoneApply: PortoneApplyService) {}

  @Post('request')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'PortOne V2 — issue VA payment params for /apply Step 4' })
  applyRequest(@CurrentUser('id') userId: string, @Body() dto: PortoneApplyRequestDto) {
    return this.portoneApply.applyPaymentRequest(userId, dto.registrationId);
  }

  @Post('confirm')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'PortOne V2 — verify VA issuance after browser SDK success' })
  applyConfirm(@CurrentUser('id') userId: string, @Body() dto: PortoneApplyConfirmDto) {
    return this.portoneApply.applyPaymentConfirm(userId, {
      paymentId: dto.paymentId,
      merchantId: dto.merchantId,
    });
  }
}

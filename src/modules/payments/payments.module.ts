import { Module } from '@nestjs/common';
import { RedisModule } from '../../integrations/redis/redis.module';
import { PrismaService } from '../../common/prisma.service';
import { PortoneWebhookSecretService } from '../../config/portone-webhook-secret.loader';
import { ApplyPaymentController } from './apply-payment.controller';
import { PortoneWebhookController } from './portone-webhook.controller';
import { PaymentsService } from './payments.service';
import { PortoneApplyService } from './portone-apply.service';
import { PortoneVerifyService } from './portone-verify.service';
import { PortoneV1Gateway } from './portone-v1.gateway';
import { PortoneV2Gateway } from './portone-v2.gateway';
import { portoneGatewayProvider } from './portone-gateway.factory';
import { PORTONE_GATEWAY } from './portone-gateway.interface';

@Module({
  imports: [RedisModule],
  controllers: [ApplyPaymentController, PortoneWebhookController],
  providers: [
    PaymentsService,
    PortoneApplyService,
    PortoneVerifyService,
    PortoneWebhookSecretService,
    PrismaService,
    PortoneV1Gateway,
    PortoneV2Gateway,
    portoneGatewayProvider,
  ],
  exports: [PaymentsService, PortoneVerifyService, PORTONE_GATEWAY],
})
export class PaymentsModule {}

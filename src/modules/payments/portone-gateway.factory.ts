import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PORTONE_GATEWAY,
  PortoneGateway,
  PortoneModuleVersion,
} from './portone-gateway.interface';
import { PortoneV1Gateway } from './portone-v1.gateway';
import { PortoneV2Gateway } from './portone-v2.gateway';

export const portoneGatewayProvider: Provider = {
  provide: PORTONE_GATEWAY,
  useFactory: (
    config: ConfigService,
    v1: PortoneV1Gateway,
    v2: PortoneV2Gateway,
  ): PortoneGateway => {
    const raw = (config.get<string>('portone.moduleVersion') ?? 'v2').toLowerCase();
    const version: PortoneModuleVersion = raw === 'v1' ? 'v1' : 'v2';
    return version === 'v1' ? v1 : v2;
  },
  inject: [ConfigService, PortoneV1Gateway, PortoneV2Gateway],
};

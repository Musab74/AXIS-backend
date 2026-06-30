import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

@Injectable()
export class PortoneWebhookSecretService {
  private readonly logger = new Logger(PortoneWebhookSecretService.name);
  private cached: string | null = null;

  constructor(private readonly config: ConfigService) {}

  async getSecret(): Promise<string> {
    if (this.cached) return this.cached;

    const fromEnv = this.config.get<string>('portone.webhookSecret') ?? '';
    if (fromEnv.trim()) {
      this.cached = fromEnv.trim();
      return this.cached;
    }

    const arn = process.env.PORTONE_WEBHOOK_SECRET_ARN?.trim();
    if (!arn) {
      throw new BadRequestException('PortOne webhook secret not configured');
    }

    const region = this.config.get<string>('aws.region') || 'ap-northeast-2';
    const client = new SecretsManagerClient({ region });
    const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
    const raw = res.SecretString?.trim();
    if (!raw) {
      throw new BadRequestException('PortOne webhook secret ARN returned empty value');
    }

    let secret = raw;
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      secret =
        parsed.webhookSecret ??
        parsed.PORTONE_WEBHOOK_SECRET ??
        parsed.secret ??
        raw;
    } catch {
      /* plain string secret */
    }

    if (!secret.trim()) {
      throw new BadRequestException('PortOne webhook secret ARN could not be parsed');
    }

    this.cached = secret.trim();
    this.logger.log('PortOne webhook secret loaded from Secrets Manager ARN');
    return this.cached;
  }
}

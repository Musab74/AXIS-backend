import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PortoneWebhookSecretService } from './portone-webhook-secret.loader';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => input),
}));

describe('PortoneWebhookSecretService', () => {
  const config = {
    get: jest.fn((k: string) => {
      if (k === 'portone.webhookSecret') return '';
      if (k === 'aws.region') return 'ap-northeast-2';
      return '';
    }),
  } as unknown as ConfigService;

  const originalArn = process.env.PORTONE_WEBHOOK_SECRET_ARN;

  afterEach(() => {
    if (originalArn === undefined) {
      delete process.env.PORTONE_WEBHOOK_SECRET_ARN;
    } else {
      process.env.PORTONE_WEBHOOK_SECRET_ARN = originalArn;
    }
    jest.clearAllMocks();
  });

  it('returns PORTONE_WEBHOOK_SECRET from config when set', async () => {
    const localConfig = {
      get: jest.fn((k: string) => (k === 'portone.webhookSecret' ? 'plain-secret' : '')),
    } as unknown as ConfigService;
    const svc = new PortoneWebhookSecretService(localConfig);
    await expect(svc.getSecret()).resolves.toBe('plain-secret');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('fetches secret from ARN when plain env is empty', async () => {
    process.env.PORTONE_WEBHOOK_SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-2:1:secret:x';
    mockSend.mockResolvedValueOnce({ SecretString: '{"webhookSecret":"from-arn"}' });
    const svc = new PortoneWebhookSecretService(config);
    await expect(svc.getSecret()).resolves.toBe('from-arn');
    expect(mockSend).toHaveBeenCalled();
  });

  it('throws when neither plain secret nor ARN is configured', async () => {
    delete process.env.PORTONE_WEBHOOK_SECRET_ARN;
    const svc = new PortoneWebhookSecretService(config);
    await expect(svc.getSecret()).rejects.toBeInstanceOf(BadRequestException);
  });
});

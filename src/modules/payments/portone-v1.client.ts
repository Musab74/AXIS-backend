import { BadRequestException, Logger } from '@nestjs/common';

const IAMPORT_BASE = 'https://api.iamport.kr';

export type IamportPaymentRow = {
  imp_uid: string;
  merchant_uid: string;
  amount: number;
  status: string;
  pay_method?: string;
  vbank_num?: string;
  vbank_name?: string;
  vbank_code?: string;
  vbank_holder?: string;
  vbank_date?: number;
};

type IamportEnvelope<T> = {
  code: number;
  message?: string | null;
  response?: T;
};

export class PortoneV1Client {
  private readonly logger = new Logger(PortoneV1Client.name);
  private tokenCache: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly impKey: string,
    private readonly impSecret: string,
  ) {}

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 30_000) {
      return this.tokenCache.token;
    }

    const res = await fetch(`${IAMPORT_BASE}/users/getToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imp_key: this.impKey, imp_secret: this.impSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as IamportEnvelope<{ access_token: string; expired_at: number }>;
    if (!res.ok || body.code !== 0 || !body.response?.access_token) {
      const msg = body.message ?? `HTTP ${res.status}`;
      throw new BadRequestException(`PortOne V1 token failed: ${msg}`);
    }

    const expiredAt =
      typeof body.response.expired_at === 'number'
        ? body.response.expired_at * 1000
        : now + 30 * 60 * 1000;
    this.tokenCache = { token: body.response.access_token, expiresAt: expiredAt };
    return body.response.access_token;
  }

  private async authFetch(path: string, init?: RequestInit): Promise<Response> {
    const token = await this.getAccessToken();
    return fetch(`${IAMPORT_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(20_000),
    });
  }

  async getPaymentByImpUid(impUid: string): Promise<IamportPaymentRow> {
    const res = await this.authFetch(`/payments/${encodeURIComponent(impUid)}`);
    const body = (await res.json()) as IamportEnvelope<IamportPaymentRow>;
    if (!res.ok || body.code !== 0 || !body.response) {
      throw new BadRequestException(
        `PortOne V1 getPayment failed: ${body.message ?? `HTTP ${res.status}`}`,
      );
    }
    return body.response;
  }

  async findPaymentByMerchantUid(
    merchantUid: string,
    status?: 'ready' | 'paid' | 'cancelled' | 'failed',
  ): Promise<IamportPaymentRow | null> {
    const statusPath = status ? `/${status}` : '';
    const res = await this.authFetch(
      `/payments/find/${encodeURIComponent(merchantUid)}${statusPath}`,
    );
    const body = (await res.json()) as IamportEnvelope<IamportPaymentRow>;
    if (body.code !== 0 || !body.response) {
      return null;
    }
    return body.response;
  }

  async cancelPayment(input: {
    impUid?: string;
    merchantUid?: string;
    amount?: number;
    reason: string;
  }): Promise<void> {
    const res = await this.authFetch('/payments/cancel', {
      method: 'POST',
      body: JSON.stringify({
        imp_uid: input.impUid,
        merchant_uid: input.merchantUid,
        amount: input.amount,
        reason: input.reason,
      }),
    });
    const body = (await res.json()) as IamportEnvelope<unknown>;
    if (!res.ok || body.code !== 0) {
      throw new BadRequestException(
        `PortOne V1 cancel failed: ${body.message ?? `HTTP ${res.status}`}`,
      );
    }
    this.logger.log(`PortOne V1 cancel ok imp_uid=${input.impUid ?? 'n/a'}`);
  }

  async probeCredentials(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.getAccessToken();
      return { ok: true, detail: 'V1 REST credentials accepted by api.iamport.kr' };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}

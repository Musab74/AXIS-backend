import { buildV1LocalVaSnapshot, iamportPaymentToPortoneLike } from './portone-v1-normalize';

describe('portone-v1-normalize', () => {
  it('maps iamport ready vbank to VIRTUAL_ACCOUNT_ISSUED', () => {
    const normalized = iamportPaymentToPortoneLike({
      imp_uid: 'imp_123',
      merchant_uid: 'AXIS-reg-1',
      amount: 100_000,
      status: 'ready',
      pay_method: 'vbank',
      vbank_num: '1234567890',
      vbank_code: '04',
      vbank_date: Math.floor(Date.now() / 1000) + 86_400,
    });
    expect(normalized.status).toBe('VIRTUAL_ACCOUNT_ISSUED');
    expect(normalized.id).toBe('imp_123');
    expect(normalized.amount.total).toBe(100_000);
    expect(normalized.method?.accountNumber).toBe('1234567890');
  });

  it('buildV1LocalVaSnapshot is issuable', () => {
    const snap = buildV1LocalVaSnapshot(50_000, 'imp_local');
    expect(snap.status).toBe('VIRTUAL_ACCOUNT_ISSUED');
    expect(snap.id).toBe('imp_local');
  });
});

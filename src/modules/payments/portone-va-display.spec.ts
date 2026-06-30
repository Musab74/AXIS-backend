import { bankEnumToKoreanLabel } from './portone-va-display';

describe('bankEnumToKoreanLabel', () => {
  it('maps PortOne server-style bank codes', () => {
    expect(bankEnumToKoreanLabel('KOOKMIN')).toBe('KB국민은행');
    expect(bankEnumToKoreanLabel('SHINHAN')).toBe('신한은행');
  });

  it('maps browser SDK bank codes', () => {
    expect(bankEnumToKoreanLabel('KOOKMIN_BANK')).toBe('KB국민은행');
    expect(bankEnumToKoreanLabel('TOSS_BANK')).toBe('토스뱅크');
  });

  it('falls back for unknown', () => {
    expect(bankEnumToKoreanLabel('UNKNOWN_BANK')).toBe('UNKNOWN_BANK');
  });
});

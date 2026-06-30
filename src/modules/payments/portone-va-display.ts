/** Korean labels for PortOne `Bank` enum (subset used in apply UI). */
const BANK_KO: Record<string, string> = {
  KOOKMIN: 'KB국민은행',
  KOOKMIN_BANK: 'KB국민은행',
  SHINHAN: '신한은행',
  SHINHAN_BANK: '신한은행',
  WOORI: '우리은행',
  WOORI_BANK: '우리은행',
  HANA: '하나은행',
  HANA_BANK: '하나은행',
  IBK: 'IBK기업은행',
  INDUSTRIAL_BANK_OF_KOREA: 'IBK기업은행',
  NONGHYUP: 'NH농협은행',
  NH_NONGHYUP_BANK: 'NH농협은행',
  KAKAO: '카카오뱅크',
  KAKAO_BANK: '카카오뱅크',
  TOSS: '토스뱅크',
  TOSS_BANK: '토스뱅크',
};

export function bankEnumToKoreanLabel(bank: string | undefined): string {
  if (!bank) return '가상계좌';
  return BANK_KO[bank] ?? bank;
}

/**
 * PII masking for admin-facing reads. Raw values stay in the DB and are only
 * released through the audited reveal endpoint (SUPER_ADMIN + reason).
 *
 * Phone numbers are stored digits-only (e.g. "01012347878") and birth dates
 * as 8 digits ("19950315") — see users.service.ts normalizers.
 */

/** "01012347878" → "010****7878". Short/empty values are fully starred. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8) return '*'.repeat(digits.length);
  return `${digits.slice(0, 3)}${'*'.repeat(digits.length - 7)}${digits.slice(-4)}`;
}

/** "19950315" → "1995****" (year visible, month/day hidden). */
export function maskBirthDate(birthDate: string | null | undefined): string | null {
  if (!birthDate) return birthDate ?? null;
  const digits = birthDate.replace(/\D/g, '');
  if (digits.length <= 4) return '*'.repeat(digits.length);
  return `${digits.slice(0, 4)}${'*'.repeat(digits.length - 4)}`;
}

import { CertLevel, CertType } from '@prisma/client';

const CERT_LABEL: Record<CertType, string> = {
  AXIS: 'AXIS',
  AXIS_C: 'AXIS-C',
  AXIS_H: 'AXIS-H',
};

/** `AXIS-C L2` — the candidate-facing name of a cert track + level, for mail and receipts. */
export function courseLabel(certType: CertType, level: CertLevel): string {
  return `${CERT_LABEL[certType] ?? String(certType)} ${String(level)}`;
}

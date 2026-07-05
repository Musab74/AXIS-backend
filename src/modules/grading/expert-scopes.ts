/**
 * Config-driven expert series (certType) competency allowlist — no DB change.
 *
 * `EXPERT_CERT_SCOPES` format: `<userId>=AXIS,AXIS_H;<userId2>=AXIS_C`.
 * Unset/empty → empty map → every expert keeps full-series access (the
 * pre-existing behavior, so this is safe to ship without configuration).
 * An expert listed here is restricted to exactly the listed series; experts
 * NOT listed keep full access (avoids locking out graders on a partial rollout).
 */
import { CertType } from '@prisma/client';

export function parseExpertCertScopes(raw: string | null | undefined): Map<string, CertType[]> {
  const scopes = new Map<string, CertType[]>();
  if (!raw?.trim()) return scopes;
  for (const entry of raw.split(';')) {
    const [id, list] = entry.split('=');
    if (!id?.trim() || !list?.trim()) continue;
    const certs = list
      .split(',')
      .map((c) => c.trim())
      .filter((c): c is CertType => c in CertType);
    if (certs.length > 0) scopes.set(id.trim(), certs);
  }
  return scopes;
}

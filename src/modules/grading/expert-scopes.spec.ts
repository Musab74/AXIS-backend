import { CertType } from '@prisma/client';
import { parseExpertCertScopes } from './expert-scopes';

describe('parseExpertCertScopes (FIX 6 — config-driven competency allowlist)', () => {
  it('unset / empty → empty map (legacy full access)', () => {
    expect(parseExpertCertScopes(undefined).size).toBe(0);
    expect(parseExpertCertScopes(null).size).toBe(0);
    expect(parseExpertCertScopes('').size).toBe(0);
    expect(parseExpertCertScopes('   ').size).toBe(0);
  });

  it('parses multiple experts with multiple series', () => {
    const scopes = parseExpertCertScopes('u1=AXIS,AXIS_H;u2=AXIS_C');
    expect(scopes.get('u1')).toEqual([CertType.AXIS, CertType.AXIS_H]);
    expect(scopes.get('u2')).toEqual([CertType.AXIS_C]);
  });

  it('ignores invalid cert names and malformed entries', () => {
    const scopes = parseExpertCertScopes('u1=AXIS,BOGUS;u2=;=AXIS_C;u3=NOPE');
    expect(scopes.get('u1')).toEqual([CertType.AXIS]);
    expect(scopes.has('u2')).toBe(false);
    expect(scopes.has('u3')).toBe(false);
    expect(scopes.size).toBe(1);
  });

  it('trims whitespace around ids and cert names', () => {
    const scopes = parseExpertCertScopes(' u1 = AXIS_H , AXIS ');
    expect(scopes.get('u1')).toEqual([CertType.AXIS_H, CertType.AXIS]);
  });
});

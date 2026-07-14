/**
 * AXIS-C / AXIS-H are suspended in the v3 cutover: their question banks are
 * purged and the exams reopen in September. A suspended series must refuse a NEW
 * session with a clear bilingual message — not fall through to the paper draw and
 * emit the raw developer error "Question bank empty for this exam".
 */
import { CertType } from '@prisma/client';
import { isSeriesSuspended, suspendedSeries } from './exam-spec';

describe('suspended series (SUSPENDED_SERIES)', () => {
  const original = process.env.SUSPENDED_SERIES;
  afterEach(() => {
    if (original === undefined) delete process.env.SUSPENDED_SERIES;
    else process.env.SUSPENDED_SERIES = original;
  });

  it('nothing is suspended by default — existing deployments are unaffected', () => {
    delete process.env.SUSPENDED_SERIES;
    expect(suspendedSeries().size).toBe(0);
    expect(isSeriesSuspended(CertType.AXIS)).toBe(false);
    expect(isSeriesSuspended(CertType.AXIS_C)).toBe(false);
  });

  it('suspends exactly the listed series, and never the base AXIS exam', () => {
    process.env.SUSPENDED_SERIES = 'AXIS_C,AXIS_H';
    expect(isSeriesSuspended(CertType.AXIS_C)).toBe(true);
    expect(isSeriesSuspended(CertType.AXIS_H)).toBe(true);
    expect(isSeriesSuspended(CertType.AXIS)).toBe(false); // the live exam must keep running
  });

  it('tolerates spacing and casing in the env value', () => {
    process.env.SUSPENDED_SERIES = ' axis_c , AXIS_H ';
    expect(isSeriesSuspended(CertType.AXIS_C)).toBe(true);
    expect(isSeriesSuspended(CertType.AXIS_H)).toBe(true);
  });
});

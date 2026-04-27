import { CertLevel } from '@prisma/client';

export interface LevelTiming {
  totalMinutes: number;
  writtenMinutes: number;
  practicalMinutes: number;
  passWritten: number;
  passPractical: number | null;
  subjectFailPct: number;
}

export const LEVEL_TIMING: Record<CertLevel, LevelTiming> = {
  L3: { totalMinutes: 40, writtenMinutes: 40, practicalMinutes: 0, passWritten: 60, passPractical: null, subjectFailPct: 40 },
  L2: { totalMinutes: 75, writtenMinutes: 30, practicalMinutes: 45, passWritten: 60, passPractical: 60, subjectFailPct: 40 },
  L1: { totalMinutes: 90, writtenMinutes: 30, practicalMinutes: 60, passWritten: 60, passPractical: 60, subjectFailPct: 40 },
};

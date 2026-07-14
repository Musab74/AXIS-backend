/**
 * Expected drawable bank sizes per (series, level).
 *
 * AXIS L1/L2/L3 reflect the v3.0 authored bank in `new_version_v3/` (imported by
 * prisma/import-new-questions.ts).
 *
 * AXIS_C (coding) and AXIS_H (healthcare) are SUSPENDED: their banks were purged
 * with the v3 cutover and those exams stay closed until the September reopening,
 * when a v3 C/H bank is authored. Expecting 0 keeps `db:validate:questions`
 * honest — if C/H rows reappear unexpectedly, the check fails loudly instead of
 * quietly passing.
 *
 * Two independent checks consume these:
 *   - `npm run db:validate:questions` — what the DATABASE actually holds.
 *   - `npm run smoke:v3` — what the shipped YAML BANK actually contains.
 * If the standard's bank grows, update here and both checks move together.
 */
export const EXPECTED_MC: Record<string, number> = {
  AXIS_L3: 400, // 객관식 400문항 은행 (27 파일)
  AXIS_L2: 310, // 정식 10회분(300: F001–F009 + B010) + 파일럿 P001(10)
  AXIS_L1: 250, // Part A 은행 배치 A1–A9 (25×10, 시험폼 P01 중복 제거)
  AXIS_C_L3: 0, // 운영 중단 (9월 재개 예정)
  AXIS_C_L2: 0,
  AXIS_C_L1: 0,
  AXIS_H_L3: 0,
  AXIS_H_L2: 0,
  AXIS_H_L1: 0,
};

/**
 * task_templates rows (PRACTICAL + ESSAY + DELIVERABLE all live in this table):
 *   AXIS_L3 = 실습형 40 (4유형 × 8 + 세트B 4 + 최초샘플 4)
 *   AXIS_L2 = 실습형 19세트 × Task A/B/C = 57
 *   AXIS_L1 = Part B 실행계획서 20 (DELIVERABLE) + Part C 서술형 60 (ESSAY) = 80
 *   AXIS_C / AXIS_H = 0 — 운영 중단 (위 주석 참조)
 */
export const EXPECTED_PRACTICAL: Record<string, number> = {
  AXIS_L3: 40,
  AXIS_L2: 57,
  AXIS_L1: 80,
  AXIS_C_L2: 0,
  AXIS_C_L1: 0,
  AXIS_H_L2: 0,
  AXIS_H_L1: 0,
};

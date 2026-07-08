import { isExamAiAllowed, isSessionAiAllowed } from './cbt-practical.service';

/**
 * 시험 표준 v2.0 AI 정책 게이트 (기획서 3-1/3-3):
 *   - 내장 AI 어시스턴트는 L2 실습에서만 허용
 *   - L1은 응시 모드 자체가 AI 전면 금지 (ai_use_blocked) — Part B 포함
 *   - L3는 AI 도구 없이 판단력만 평가
 *   - v1.1 레거시 세션은 과제별 aiToolAllowed 정책만 따른다
 */
describe('isSessionAiAllowed (v2.0 level gate)', () => {
  it('allows only L2 for spec v2.0 sessions', () => {
    expect(isSessionAiAllowed('2.0', 'L2')).toBe(true);
    expect(isSessionAiAllowed('2.0', 'L1')).toBe(false); // Part B 포함 전면 금지
    expect(isSessionAiAllowed('2.0', 'L3')).toBe(false);
  });

  it('leaves legacy v1.1 sessions to the per-task policy', () => {
    expect(isSessionAiAllowed('1.1', 'L1')).toBe(true);
    expect(isSessionAiAllowed('1.1', 'L3')).toBe(true);
    expect(isSessionAiAllowed(null, 'L1')).toBe(true);
    expect(isSessionAiAllowed(undefined, 'L2')).toBe(true);
  });
});

describe('isExamAiAllowed (per-task policy)', () => {
  it('grants only when the authored field explicitly allows a tool', () => {
    expect(isExamAiAllowed('LMS 내장 AI')).toBe(true);
    expect(isExamAiAllowed('시험 시스템 내장 AI')).toBe(true);
  });

  it('rejects explicit prohibitions and empty policies', () => {
    expect(isExamAiAllowed('AI 사용 불가')).toBe(false);
    expect(isExamAiAllowed('사용 금지')).toBe(false);
    expect(isExamAiAllowed('none')).toBe(false);
    expect(isExamAiAllowed('')).toBe(false);
    expect(isExamAiAllowed(null)).toBe(false);
    expect(isExamAiAllowed(undefined)).toBe(false);
  });
});

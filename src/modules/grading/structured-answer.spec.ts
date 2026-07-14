/**
 * The structured answer a candidate submits is a JSON envelope. Neither the AI
 * grader nor a human reviewer may ever see that raw JSON — this locks in the
 * rendering contract for both.
 */
import { fuzzyEqual } from './l3-text-match';
import { renderStructuredAnswer } from './structured-answer';

const L3_RUBRIC = {
  practiceType: '분석검증형',
  responseFormat: {
    selection_fields: [
      {
        name: '제출 전 처리 필요 문제 (3개 선택)',
        select_count: 3,
        options: {
          I1: '매각 권고가 근거 없이 단정되어 있다',
          I2: '표의 단위가 누락되어 있다',
          I3: '재고 판단 기준이 제시되지 않았다',
          I4: '작성자 서명이 없다',
          I5: '전망 문장이 실적과 무관하다',
          I6: '개인정보가 노출되어 있다',
        },
      },
      {
        name: '가장 먼저 할 검증 조치 (1개 선택)',
        select_count: 1,
        options: { V1: '문서를 폐기한다', V2: '원자료와 대조한다', V3: '스스로 다시 읽는다', V4: '그대로 제출한다' },
      },
    ],
    generation_field: { name: '매각 권고 문장 수정 지시문', limit: '80자 이내' },
    short_reason: '80~150자',
  },
  answerKey: { issues: ['I1', 'I3', 'I5'], first_verification: ['V2'], key_reason: '…', example_prompt: '…' },
};

describe('renderStructuredAnswer', () => {
  it('resolves L3 option CODES to their display text, under the real field labels', () => {
    const envelope = JSON.stringify({
      version: 3,
      selects: { issues: ['I1', 'I3', 'I5'], first_verification: ['V2'] },
      writePrompt: '매각 권고 문장을 삭제하고 현황 서술만 남겨라.',
      shortReason: '표의 수치가 재고 판단 기준 없이 매각을 단정하고 있어 근거가 부족하다.',
    });

    const out = renderStructuredAnswer(L3_RUBRIC, envelope);

    // Field labels come from the bank, not from the key names.
    expect(out).toContain('[제출 전 처리 필요 문제 (3개 선택)]');
    expect(out).toContain('[가장 먼저 할 검증 조치 (1개 선택)]');
    // Codes are kept (the grader/expert reason in codes) AND resolved to text.
    expect(out).toContain('- I1: 매각 권고가 근거 없이 단정되어 있다');
    expect(out).toContain('- V2: 원자료와 대조한다');
    // The two free-text fields are labelled.
    expect(out).toContain('[매각 권고 문장 수정 지시문]');
    expect(out).toContain('[판단 근거]');
    // And no JSON reaches the reader.
    expect(out).not.toContain('{');
    expect(out).not.toContain('"selects"');
  });

  it('never leaks an unselected option or the answer key', () => {
    const out = renderStructuredAnswer(
      L3_RUBRIC,
      JSON.stringify({ version: 3, selects: { issues: ['I2'] }, shortReason: 'x' }),
    );
    expect(out).toContain('I2');
    expect(out).not.toContain('I1'); // not chosen ⇒ not rendered
    expect(out).not.toContain('example_prompt');
  });

  it('renders an L2 verification-memo table as readable rows', () => {
    const out = renderStructuredAnswer(null, JSON.stringify({
      version: 3,
      kind: 'L2_B',
      summary: '이수율 79%는 재수강자를 포함한 수치다.',
      memos: [
        { 주장: '이수율 79%', 판정: '오류', 근거: '재수강 12명 중복', 조치: '재계산' },
        { 주장: '업계 평균 92%', 판정: '사용 보류', 근거: '출처 불명', 조치: '출처 확인' },
      ],
      corrections: ['79% 수치 수정', '92% 삭제'],
    }));
    expect(out).toContain('[핵심 요약]');
    expect(out).toContain('[검증 메모]');
    expect(out).toContain('1. 주장: 이수율 79% | 판정: 오류 | 근거: 재수강 12명 중복 | 조치: 재계산');
    expect(out).toContain('[수정 대상 목록]');
    expect(out).not.toContain('{');
  });

  it('passes plain prose through untouched (legacy rows)', () => {
    const prose = '이 보고서는 근거가 부족합니다.';
    expect(renderStructuredAnswer(null, prose)).toBe(prose);
  });

  it('still grades a free-text answer preserved through the structured-UI rollout', () => {
    // A candidate mid-exam when the structured UI deployed: the client carries
    // their original prose in `legacyText` instead of overwriting it. It MUST
    // still reach the grader, or the rollout would silently zero them.
    const out = renderStructuredAnswer(
      null,
      JSON.stringify({
        version: 3,
        kind: 'L1_C',
        legacyText: '즉시 외부 AI 입력을 중단시키고 로그를 보존한다.',
        elements: { e1: '접근 차단' },
      }),
    );
    expect(out).toContain('[이전 작성 답안]');
    expect(out).toContain('즉시 외부 AI 입력을 중단시키고 로그를 보존한다.');
    expect(out).toContain('접근 차단');
  });

  it('falls back to the raw text on unparseable input rather than losing the answer', () => {
    expect(renderStructuredAnswer(null, '{not json')).toBe('{not json');
  });
});

describe('fuzzyEqual · option codes are exact (B4)', () => {
  it('does not equate E1 with E10 — the substring rule would mis-grade a 10+ option field', () => {
    expect(fuzzyEqual('E1', 'E10')).toBe(false);
    expect(fuzzyEqual('E10', 'E1')).toBe(false);
    expect(fuzzyEqual('E1', 'E1')).toBe(true);
    expect(fuzzyEqual('e1', 'E1')).toBe(true); // case-insensitive
    expect(fuzzyEqual('T2', 'T3')).toBe(false);
  });

  it('still matches Korean phrases fuzzily (regression)', () => {
    expect(fuzzyEqual('보고서 초안', '보고서초안')).toBe(true);
  });
});

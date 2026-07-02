import {
  L3PracticalGraderService,
  parseL3RubricPayload,
  parseL3Submission,
  L3GradeTask,
} from './l3-practical-grader.service';

/**
 * Sample rubric wrappers mirror the AXIS_L3_실습형_샘플문항_세트_v1_1.yaml shape
 * as seeded by prisma/seed-l3-practicals.ts (see task's CONTEXT).
 */
const 현업적용형: L3GradeTask = {
  points: 10,
  rubric: {
    itemId: 'AXIS-L3-P-1',
    practiceType: '현업적용형',
    responseFormat: {
      select: ['AI 활용 가능 작업', '사람 검토 지점', '제외해야 할 입력자료'],
      short_reason: '80~150자',
    },
    answerKey: {
      ai_usable_tasks: ['보도자료 초안 작성', '회의록 요약'],
      human_review_points: ['수치 검증', '법적 표현 검토'],
      must_exclude_input: '고객 개인정보가 포함된 원본 명단',
      key_reason: '개인정보와 미확정 수치는 외부 AI 입력에서 제외하고 사람이 최종 검토해야 한다',
    },
    rubric: [
      { criterion: 'AI 활용 작업 선정', points: 3, description: '적합한 작업 식별' },
      { criterion: '사람 검토 지점', points: 3, description: '검증 지점 식별' },
      { criterion: '제외 입력자료', points: 3, description: '민감정보 제외' },
      { criterion: '근거', points: 1, description: '80~150자 근거' },
    ],
  },
};

const 리스크판단형: L3GradeTask = {
  points: 10,
  rubric: {
    practiceType: '리스크 판단형',
    responseFormat: {
      select_highest_risk: ['개인정보 외부 입력', '오탈자'],
      select_immediate_action: '입력 중단 및 비식별·승인된 환경 사용',
      short_reason: '80~150자',
    },
    answerKey: {
      highest_risk: '개인정보 외부 입력',
      immediate_action: '입력 중단 및 비식별·승인된 환경 사용',
      key_reason: '식별 가능한 개인정보를 외부 AI에 입력하면 유출 위험이 크다',
    },
    rubric: [
      { criterion: '위험 식별', points: 5, description: '최고 위험 선택' },
      { criterion: '즉시 조치', points: 4, description: '올바른 대응' },
      { criterion: '근거', points: 1, description: '80~150자 근거' },
    ],
  },
};

const grader = new L3PracticalGraderService();

const GOOD_현업적용_REASON =
  '고객 개인정보와 미확정 수치는 외부 AI 입력에서 제외하고, 초안 작성만 AI로 처리한 뒤 담당자가 수치와 법적 표현을 최종 검토해야 개인정보 유출과 오류를 막을 수 있다.';

describe('parseL3RubricPayload', () => {
  it('splits the wrapper into answerKey, weighted criteria, and responseFormat', () => {
    const p = parseL3RubricPayload(현업적용형.rubric);
    expect(p.answerKey?.must_exclude_input).toBe('고객 개인정보가 포함된 원본 명단');
    expect(p.responseFormat?.short_reason).toBe('80~150자');
    expect(p.criteria).toHaveLength(4);
    expect(p.criteria.reduce((s, c) => s + c.maxPoints, 0)).toBe(10);
    // Task 4: an L3 wrapper with a nested answerKey is NOT collapsed to Overall.
    expect(p.criteria.map((c) => c.maxPoints)).toEqual([3, 3, 3, 1]);
  });
});

describe('parseL3Submission', () => {
  it('decodes a structured JSON answer and separates rationale from selections', () => {
    const sub = parseL3Submission(
      JSON.stringify({ ai_usable_tasks: ['회의록 요약'], short_reason: '근거 텍스트' }),
    );
    expect(sub).not.toBeNull();
    expect(sub!.rationale).toBe('근거 텍스트');
    expect(sub!.selections.ai_usable_tasks).toEqual(['회의록 요약']);
    expect(sub!.selections.short_reason).toBeUndefined();
  });

  it('returns null for legacy free-text and invalid JSON', () => {
    expect(parseL3Submission('This is a plain essay answer.')).toBeNull();
    expect(parseL3Submission('{ not valid json')).toBeNull();
    expect(parseL3Submission('')).toBeNull();
  });

  it('unwraps the versioned { selects, shortReason } envelope from the L3 UI', () => {
    const sub = parseL3Submission(
      JSON.stringify({
        version: 1,
        selects: { ai_usable_tasks: ['회의록 요약'], must_exclude_input: '고객 명단' },
        shortReason: '개인정보는 제외하고 담당자가 검토해야 한다.',
      }),
    );
    expect(sub).not.toBeNull();
    expect(sub!.rationale).toBe('개인정보는 제외하고 담당자가 검토해야 한다.');
    expect(sub!.selections.ai_usable_tasks).toEqual(['회의록 요약']);
    expect(sub!.selections.must_exclude_input).toBe('고객 명단');
    // envelope bookkeeping keys must not leak into the objective selections
    expect(sub!.selections.version).toBeUndefined();
    expect(sub!.selections.selects).toBeUndefined();
  });
});

describe('gradeL3Practical — objective scoring', () => {
  it('awards near-full credit for a correct answer and does not flag review', () => {
    const sub = parseL3Submission(
      JSON.stringify({
        ai_usable_tasks: ['보도자료 초안 작성', '회의록 요약'],
        human_review_points: ['수치 검증', '법적 표현 검토'],
        must_exclude_input: '고객 개인정보가 포함된 원본 명단',
        short_reason: GOOD_현업적용_REASON,
      }),
    )!;
    const r = grader.gradeL3Practical(현업적용형, sub);
    expect(r.earnedPoints).toBeGreaterThanOrEqual(9);
    expect(r.pct).toBeGreaterThanOrEqual(90);
    expect(r.breakdown.objectiveScore).toBeGreaterThanOrEqual(8.5);
    expect(r.needsExpertReview).toBe(false);
    expect(r.riskFlags).toHaveLength(0);
  });

  it('scores partially when only some selections match', () => {
    const sub = parseL3Submission(
      JSON.stringify({
        ai_usable_tasks: ['보도자료 초안 작성'], // 1 of 2
        human_review_points: [], // none
        must_exclude_input: '고객 개인정보가 포함된 원본 명단', // correct
        short_reason: GOOD_현업적용_REASON,
      }),
    )!;
    const r = grader.gradeL3Practical(현업적용형, sub);
    expect(r.earnedPoints).toBeLessThan(9);
    expect(r.earnedPoints).toBeGreaterThan(3);
  });
});

describe('gradeL3Practical — expert-review triggers', () => {
  it('flags a risk-type item scoring ≤ half its points', () => {
    const sub = parseL3Submission(
      JSON.stringify({
        highest_risk: '오탈자', // wrong
        immediate_action: '맞춤법 검사', // wrong
        short_reason: '문서를 다시 읽어보며 맞춤법을 점검하는 것이 우선이라고 생각한다는 취지의 서술입니다.',
      }),
    )!;
    const r = grader.gradeL3Practical(리스크판단형, sub);
    expect(r.needsExpertReview).toBe(true);
    expect(r.riskFlags.map((f) => f.code)).toContain('risk_item_low_score');
  });

  it('raises a HIGH PII flag when the rationale leaks personal data', () => {
    const sub = parseL3Submission(
      JSON.stringify({
        highest_risk: '개인정보 외부 입력',
        immediate_action: '입력 중단 및 비식별·승인된 환경 사용',
        short_reason: '담당자 홍길동 010-1234-5678 에게 확인 후 개인정보 외부 입력을 즉시 중단해야 한다.',
      }),
    )!;
    const r = grader.gradeL3Practical(리스크판단형, sub);
    const pii = r.riskFlags.find((f) => f.code === 'phone_number');
    expect(pii?.severity).toBe('HIGH');
    expect(r.needsExpertReview).toBe(true);
  });

  it('flags a rationale that contradicts otherwise-correct selections', () => {
    const sub = parseL3Submission(
      JSON.stringify({
        ai_usable_tasks: ['보도자료 초안 작성', '회의록 요약'],
        human_review_points: ['수치 검증', '법적 표현 검토'],
        must_exclude_input: '고객 개인정보가 포함된 원본 명단',
        // 40+ chars, correct selections, but shares no concept with the key.
        short_reason: '오늘 날씨가 매우 좋아서 점심으로 김치찌개를 먹을 예정이며 오후에는 산책을 다녀올 생각이라 기분이 즐겁다.',
      }),
    )!;
    const r = grader.gradeL3Practical(현업적용형, sub);
    expect(r.riskFlags.map((f) => f.code)).toContain('rationale_contradiction');
    expect(r.needsExpertReview).toBe(true);
  });
});

describe('gradeL3Practical — Claude rationale assist', () => {
  it('marks a borderline rationale (partial concept coverage) for assist', () => {
    const task: L3GradeTask = {
      points: 10,
      rubric: {
        practiceType: '현업적용형',
        answerKey: {
          ai_usable_tasks: ['회의록 요약'],
          key_reason: '개인정보 수치 검토 필요',
        },
        rubric: [
          { criterion: '작업 선정', points: 9, description: '...' },
          { criterion: '근거', points: 1, description: '...' },
        ],
      },
    };
    const sub = parseL3Submission(
      JSON.stringify({
        ai_usable_tasks: ['회의록 요약'],
        // mentions only 1 of the 4 key concepts → coverage ~0.25 (borderline band)
        short_reason: '개인정보 보호를 위해 담당자가 신중하게 처리해야 하는 상황이라고 생각하며 충분히 대비해야 한다.',
      }),
    )!;
    const r = grader.gradeL3Practical(task, sub);
    expect(r.needsClaudeRationaleAssist).toBe(true);
  });
});

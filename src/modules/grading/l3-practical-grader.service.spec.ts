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

  it('raises a critical PII flag when the rationale leaks personal data', () => {
    const sub = parseL3Submission(
      JSON.stringify({
        highest_risk: '개인정보 외부 입력',
        immediate_action: '입력 중단 및 비식별·승인된 환경 사용',
        short_reason: '담당자 홍길동 010-1234-5678 에게 확인 후 개인정보 외부 입력을 즉시 중단해야 한다.',
      }),
    )!;
    const r = grader.gradeL3Practical(리스크판단형, sub);
    // v2.0 (WP6): PII regex hits map onto the L3 controlled-vocabulary tag
    // '개인정보 입력' with SYSTEM-side severity (critical); the matched regex
    // pattern code stays in the detail for the reviewer.
    const pii = r.riskFlags.find((f) => f.code === '개인정보 입력');
    expect(pii?.severity).toBe('CRITICAL');
    expect(pii?.detail).toContain('phone_number');
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
    // v2.0 (WP6): the contradiction heuristic IS the deterministic arm of the
    // 선택-근거 일치 게이트 — it nominates, the expert confirms the zeroing.
    expect(r.gate.triggered).toBe(true);
    expect(r.gate.rule).toBe('선택-근거 일치 게이트');
    expect(r.gate.contradiction).toBeTruthy();
  });

  it('leaves the gate untriggered on a coherent answer', () => {
    const sub = parseL3Submission(
      JSON.stringify({
        ai_usable_tasks: ['보도자료 초안 작성', '회의록 요약'],
        human_review_points: ['수치 검증', '법적 표현 검토'],
        must_exclude_input: '고객 개인정보가 포함된 원본 명단',
        short_reason:
          '고객 개인정보가 포함된 명단은 입력에서 제외하고, 보도자료와 회의록 요약처럼 공개 가능한 자료만 AI에 맡기는 것이 안전하기 때문이다.',
      }),
    )!;
    const r = grader.gradeL3Practical(현업적용형, sub);
    expect(r.gate.triggered).toBe(false);
    expect(r.gate.contradiction).toBeNull();
  });

  // Regression: a long two-clause key_reason once made a genuinely on-topic
  // rationale score coverage 0 (extractKeywords took only the opening clause),
  // falsely tripping the gate. Even-sampled keywords must keep this clean.
  it('does NOT gate a correct rationale against a long two-clause key_reason', () => {
    const task: L3GradeTask = {
      points: 10,
      rubric: {
        practiceType: '현업적용형',
        fieldPoints: { tasks: 4, excluded_materials: 1, review_point: 1 },
        riskControl: { points: 2, penaltyPerHit: 1 },
        mustNotChoose: ['T1', 'T3', 'T5'],
        answerKey: {
          tasks: ['T2', 'T4'],
          excluded_materials: ['M2', 'M5'],
          review_point: ['R1'],
          key_reason:
            '금액란과 수신자란이 비워진 서식과 게시된 절차 문서, 날짜만 담긴 일정표는 입력 가능하다. ' +
            '확정 전 금액표와 이름·연락처가 담긴 담당자 파일은 지침의 금지 범주이며 최종 확인은 사람의 책임이다.',
        },
        rubric: [
          { criterion: '핵심 판단', points: 4 },
          { criterion: '자료·절차', points: 2 },
          { criterion: '위험통제', points: 2 },
          { criterion: '근거', points: 2 },
        ],
      },
    };
    const sub = parseL3Submission(
      JSON.stringify({
        selects: { tasks: ['T2', 'T4'], excluded_materials: ['M2', 'M5'], review_point: ['R1'] },
        shortReason:
          '확정 전 금액표와 담당자 연락처 파일은 회사 지침이 금지한 개인정보·미확정 정보이므로 입력할 수 없고, ' +
          '금액과 수신 대상의 최종 일치는 사람이 발송 전에 반드시 확인해야 하기 때문입니다.',
      }),
    )!;
    const r = grader.gradeL3Practical(task, sub);
    expect(r.gate.triggered).toBe(false);
    expect(r.riskFlags.map((f) => f.code)).not.toContain('rationale_contradiction');
    expect(r.earnedPoints).toBeGreaterThanOrEqual(9);
  });

  // The precise unsafe-advocacy detector: a reason that USES the right
  // vocabulary but argues for the forbidden action must still gate.
  it('gates a rationale that advocates the unsafe action despite right selections', () => {
    const task: L3GradeTask = {
      points: 10,
      rubric: {
        practiceType: '현업적용형',
        fieldPoints: { tasks: 4, excluded_materials: 1, review_point: 1 },
        mustNotChoose: [],
        answerKey: {
          tasks: ['T2', 'T4'],
          excluded_materials: ['M2', 'M5'],
          review_point: ['R1'],
          key_reason: '확정 전 금액표와 담당자 연락처 파일은 입력 금지이며 사람이 최종 확인해야 한다.',
        },
        rubric: [
          { criterion: '핵심 판단', points: 4 },
          { criterion: '자료·절차', points: 2 },
          { criterion: '위험통제', points: 2 },
          { criterion: '근거', points: 2 },
        ],
      },
    };
    const sub = parseL3Submission(
      JSON.stringify({
        selects: { tasks: ['T2', 'T4'], excluded_materials: ['M2', 'M5'], review_point: ['R1'] },
        shortReason:
          '확정 전 금액표와 담당자 연락처 파일도 편의를 위해 그대로 외부 도구에 입력해도 전혀 문제가 없으며 ' +
          '사람이 다시 확인할 필요도 없다고 판단했기 때문입니다.',
      }),
    )!;
    const r = grader.gradeL3Practical(task, sub);
    expect(r.gate.triggered).toBe(true);
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

/**
 * v2.0 (WP9) 루브릭 v2.1 정렬: per-criterion splits via `fieldPoints`,
 * penalty-based 위험통제, generated-text criteria, must-not-choose 감점.
 * Mirrors 실습 1 (현업적용형 4/2/2/2) and 실습 2 (지시설계형 3/3/2/2) of
 * AXIS_L3_실습형_샘플문항_세트_v2_0.yaml.
 */
describe('gradeL3Practical — v2.0 per-criterion splits (WP9)', () => {
  const 현업적용형V2: L3GradeTask = {
    points: 10,
    rubric: {
      practiceType: '현업적용형',
      rubric_version: '2.0',
      answerKey: {
        tasks: ['T1', 'T2'],
        excluded_materials: ['M2', 'M3'],
        review_point: ['R1'],
        key_reason:
          '게시·발송 완료 자료와 무기명 집계 수치는 입력 가능하고, 작성 중 평가 메모와 연락처 목록은 지침상 금지 대상이다. 최종 사실 확인은 사람의 책임이다.',
      },
      fieldPoints: { tasks: 4, excluded_materials: 1, review_point: 1 },
      riskControl: { points: 2, penaltyPerHit: 1 },
      mustNotChoose: ['T3', 'T4', 'T5'],
      rubric: [
        { criterion: '핵심 판단', points: 4, description: '맡길 작업의 정확한 구분' },
        { criterion: '자료·절차', points: 2, description: '금지 자료·검토 지점 선택' },
        { criterion: '위험통제', points: 2, description: '금지 옵션 미선택' },
        { criterion: '근거', points: 2, description: '지침 인용 2점 / 일반론 1점 / 모순 0점+게이트' },
      ],
    },
  };

  const PERFECT_REASON =
    '게시 완료된 업무 요약과 무기명 집계 수치는 입력 가능하고, 작성 중 평가 메모와 연락처 목록은 지침상 금지 대상이므로 제외했으며 최종 사실 확인은 사람의 책임이다.';

  it('scores objective fields by their per-criterion points (4/1/1), not an even split', () => {
    const sub = parseL3Submission(
      JSON.stringify({
        tasks: ['T1', 'T2'],
        excluded_materials: ['M2', 'M3'],
        review_point: ['R1'],
        short_reason: PERFECT_REASON,
      }),
    )!;
    const r = grader.gradeL3Practical(현업적용형V2, sub);
    const byKey = new Map(r.breakdown.details.map((d) => [d.key, d]));
    expect(byKey.get('tasks')?.points).toBe(4);
    expect(byKey.get('tasks')?.earned).toBe(4);
    expect(byKey.get('excluded_materials')?.points).toBe(1);
    expect(byKey.get('review_point')?.points).toBe(1);
    // 위험통제: no banned option selected → full 2.
    expect(byKey.get('risk_control')?.earned).toBe(2);
    // Rationale is fixed at 2 pts in every v2.0 type.
    expect(byKey.get('rationale')?.points).toBe(2);
    expect(r.earnedPoints).toBeGreaterThanOrEqual(9); // 8 auto + rationale ≥1
  });

  it('deducts the 위험통제 penalty and flags must-not-choose selections (dev spec T4)', () => {
    const sub = parseL3Submission(
      JSON.stringify({
        tasks: ['T1', 'T3'], // T3 is banned
        excluded_materials: ['M2', 'M3'],
        review_point: ['R1'],
        short_reason: PERFECT_REASON,
      }),
    )!;
    const r = grader.gradeL3Practical(현업적용형V2, sub);
    const rc = r.breakdown.details.find((d) => d.key === 'risk_control');
    expect(rc?.earned).toBe(1); // 2 − 1 hit
    expect(r.riskFlags.map((f) => f.code)).toContain('must_not_choose_selected');
    expect(r.needsExpertReview).toBe(true);
  });

  it('scores generated criteria: 지시 보완 by example-prompt coverage, 검증요청 by pattern', () => {
    const 지시설계형V2: L3GradeTask = {
      points: 10,
      rubric: {
        practiceType: '지시설계형',
        rubric_version: '2.0',
        answerKey: {
          elements: ['E1', 'E2', 'E3', 'E4', 'E5'],
          example_prompt:
            '5년 거래한 구매팀 김 부장님께 보낼 납기 3일 지연 사과 메일을 작성해줘. 행사 일정 차질 사과와 재발 방지 약속을 포함하고 분량은 간결하게. 과장 표현이 있으면 표시해줘.',
          key_reason: '요청문의 조건은 상사 메시지와 고객 메일이라는 원자료에서 추출해야 한다.',
        },
        fieldPoints: { elements: 3 },
        mustNotChoose: ['E6', 'E7', 'E8'],
        generatedCriteria: [
          { label: '지시 보완', points: 3, kind: 'prompt_quality' },
          { label: '검증요청', points: 2, kind: 'verification_request' },
        ],
        rubric: [
          { criterion: '조건 추출·누락요소 식별', points: 3, description: '원문 근거 요소 추출' },
          { criterion: '지시 보완', points: 3, description: '실사용 가능 요청문' },
          { criterion: '검증요청', points: 2, description: '검증 요청 포함' },
          { criterion: '근거', points: 2, description: '원문 인용 2점 / 일반론 1점' },
        ],
      },
    };
    const sub = parseL3Submission(
      JSON.stringify({
        elements: ['E1', 'E2', 'E3', 'E4', 'E5'],
        write_prompt:
          '5년 거래한 구매팀 김 부장님께 납기 3일 지연 사과 메일을 간결하게 작성해줘. 행사 일정 차질을 사과하고 재발 방지 조치를 약속하는 내용을 포함하고, 과장되거나 책임 회피하는 표현이 있으면 표시해줘.',
        short_reason:
          '상사 메시지와 고객 메일 원문에 있는 지연 기간, 행사 차질, 거래 관계, 분량, 재발 방지 조건만 반영하고 원문에 없는 보상 제안은 지어 넣지 않았다.',
      }),
    )!;
    const r = grader.gradeL3Practical(지시설계형V2, sub);
    const byKey = new Map(r.breakdown.details.map((d) => [d.key, d]));
    expect(byKey.get('elements')?.points).toBe(3);
    expect(byKey.get('지시 보완')?.kind).toBe('generated');
    expect(byKey.get('지시 보완')?.earned).toBeGreaterThan(1.5); // strong prompt coverage
    expect(byKey.get('검증요청')?.earned).toBe(2); // 표시해줘 → verification request present
    expect(r.earnedPoints).toBeGreaterThanOrEqual(8);
  });

  it('parseL3RubricPayload exposes the v2.0 wrapper fields', () => {
    const p = parseL3RubricPayload(현업적용형V2.rubric);
    expect(p.fieldPoints).toEqual({ tasks: 4, excluded_materials: 1, review_point: 1 });
    expect(p.riskControl).toEqual({ points: 2, penaltyPerHit: 1 });
    expect(p.mustNotChoose).toEqual(['T3', 'T4', 'T5']);
  });
});

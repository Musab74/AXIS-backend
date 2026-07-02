import { parseRubric, parseL3Reference } from './rubric';

describe('parseRubric', () => {
  it('honours explicit (n점) weights when they sum to the task total', () => {
    const rubric = {
      criteria: [
        '전략 논리성(15점): 목표 선정·우선순위·근거',
        'ROI·KPI 설계(12점): 정량 효과·측정 가능 KPI',
        '실행 계획(13점): 단계·책임·산출물',
      ],
    };
    const out = parseRubric(rubric, 40);
    expect(out.map((c) => c.maxPoints)).toEqual([15, 12, 13]);
    expect(out.map((c) => c.key)).toEqual(['C1', 'C2', 'C3']);
    expect(out.reduce((s, c) => s + c.maxPoints, 0)).toBe(40);
  });

  it('distributes points evenly when criteria carry no weights', () => {
    const rubric = { criteria: ['A 기준', 'B 기준', 'C 기준', 'D 기준'] };
    const out = parseRubric(rubric, 40);
    expect(out).toHaveLength(4);
    expect(out.every((c) => c.maxPoints === 10)).toBe(true);
  });

  it('handles the { raw } fallback shape with " | " separators', () => {
    const rubric = { raw: '구성 완성도 | 실행 가능성 | 리스크 통제' };
    const out = parseRubric(rubric, 30);
    expect(out).toHaveLength(3);
    expect(out.every((c) => c.maxPoints === 10)).toBe(true);
  });

  it('never returns an empty rubric — falls back to a single Overall criterion', () => {
    const out = parseRubric({ criteria: [] }, 20);
    expect(out).toHaveLength(1);
    expect(out[0].maxPoints).toBe(20);
  });

  it('mixes explicit and implicit weights, splitting the remainder', () => {
    const rubric = { criteria: ['핵심(20점): ...', '보조 1', '보조 2'] };
    const out = parseRubric(rubric, 40);
    expect(out[0].maxPoints).toBe(20);
    // remaining 20 split across 2 unweighted → 10 each
    expect(out[1].maxPoints).toBe(10);
    expect(out[2].maxPoints).toBe(10);
  });

  it('parses the L3 실습형 wrapper — inner rubric array → weighted criteria', () => {
    const rubric = {
      itemId: 'AXIS-L3-P-SAMPLE-001',
      practiceType: '현업적용형',
      answerKey: { key_reason: '...' },
      rubric: [
        { criterion: '핵심 판단', points: 4, description: 'AI 활용 작업 선정의 타당성' },
        { criterion: '근거 서술', points: 3, description: '80~150자 근거의 구체성' },
        { criterion: '누락/오류 방지', points: 3, description: '제외 입력자료 식별' },
      ],
    };
    const out = parseRubric(rubric, 10);
    expect(out.map((c) => c.maxPoints)).toEqual([4, 3, 3]);
    expect(out.map((c) => c.key)).toEqual(['C1', 'C2', 'C3']);
    expect(out.reduce((s, c) => s + c.maxPoints, 0)).toBe(10);
    expect(out[0].label).toContain('핵심 판단');
  });

  it('does NOT collapse an L3 rubric into a single Overall criterion', () => {
    const rubric = {
      practiceType: '분석·검증형',
      rubric: [
        { criterion: '문제 식별', points: 5 },
        { criterion: '최초 조치', points: 5 },
      ],
    };
    const out = parseRubric(rubric, 10);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.maxPoints)).toEqual([5, 5]);
  });
});

describe('parseL3Reference', () => {
  it('extracts practiceType, responseFormat, answerKey and riskFlags from the L3 wrapper', () => {
    const rubric = {
      practiceType: '리스크 판단형',
      responseFormat: { select_highest_risk: ['개인정보 외부 입력'], short_reason: '80~150자' },
      answerKey: { highest_risk: '개인정보 외부 입력', immediate_action: '입력 중단' },
      riskFlags: ['개인정보 입력', '식별정보 노출'],
      rubric: [{ criterion: '판단', points: 10 }],
    };
    const ref = parseL3Reference(rubric);
    expect(ref).not.toBeNull();
    expect(ref!.practiceType).toBe('리스크 판단형');
    expect(ref!.answerKey).toContain('개인정보 외부 입력');
    expect(ref!.responseFormat).toContain('short_reason');
    expect(ref!.riskFlags).toContain('식별정보 노출');
  });

  it('returns null for legacy L1/L2 rubric shapes', () => {
    expect(parseL3Reference({ criteria: ['A(10점)', 'B(10점)'] })).toBeNull();
    expect(parseL3Reference({ raw: 'a | b | c' })).toBeNull();
    expect(parseL3Reference('freeform string')).toBeNull();
    expect(parseL3Reference(null)).toBeNull();
  });
});

import { parseRubric } from './rubric';

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
});

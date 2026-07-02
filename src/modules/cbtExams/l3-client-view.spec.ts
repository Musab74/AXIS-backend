import { l3ClientView } from './cbt-exams.service';

/**
 * The paper client-view must (a) key each field by the answerKey field NAME so
 * the candidate's `selects` line up with the grader, (b) pull option pools from
 * responseFormat, and (c) NEVER serialize the answerKey values / key_reason.
 */
describe('l3ClientView', () => {
  const 분석검증 = {
    practiceType: '분석·검증형',
    responseFormat: {
      select_issues: ['출처 없는 수치', '과도한 일반화', '논리 비약', '표본 편향'],
      select_first_action: '원자료·공식 통계 출처 확인',
      short_reason: '80~150자',
    },
    answerKey: {
      required_issues: ['출처 없는 수치', '논리 비약'],
      first_action: '원자료 출처 확인',
      key_reason: '수치의 출처를 먼저 확인해야 한다',
    },
    rubric: [{ criterion: '문제 식별', points: 9 }, { criterion: '근거', points: 1 }],
  };

  it('keys fields by answerKey field names and attaches responseFormat option pools', () => {
    const v = l3ClientView(분석검증)!;
    expect(v.practiceType).toBe('분석·검증형');
    const issues = v.fields.find((f) => f.key === 'required_issues');
    // multi-select, options from responseFormat.select_issues (prefix-normalized match)
    expect(issues?.kind).toBe('multi');
    expect(issues?.options).toEqual(['출처 없는 수치', '과도한 일반화', '논리 비약', '표본 편향']);
    // single string field with no array pool → free text input
    expect(v.fields.find((f) => f.key === 'first_action')?.kind).toBe('text');
    expect(v.reason).toEqual({ min: 80, max: 150 });
  });

  it('NEVER leaks answerKey values or key_reason to the client', () => {
    const v = l3ClientView(분석검증)!;
    const json = JSON.stringify(v);
    // The correct subset (required_issues values) and key_reason must be absent.
    expect(json).not.toContain('key_reason');
    expect(json).not.toContain('수치의 출처를 먼저'); // key_reason text
    expect(v.fields.some((f) => f.key === 'key_reason')).toBe(false);
    // The options pool (distractors + correct, unmarked) is the only list sent;
    // there is no field revealing WHICH options are correct.
    expect(v.fields.every((f) => !('correct' in f))).toBe(true);
  });

  it('renders array answerKey fields with no pool as free multi-entry (현업적용형)', () => {
    const v = l3ClientView({
      practiceType: '현업적용형',
      responseFormat: { select: ['AI 활용 가능 작업', '사람 검토 지점'], short_reason: '80~150자' },
      answerKey: { ai_usable_tasks: ['보도자료 초안'], must_exclude_input: '고객 명단', key_reason: '...' },
    })!;
    expect(v.fields.find((f) => f.key === 'ai_usable_tasks')?.kind).toBe('multiText');
    expect(v.fields.find((f) => f.key === 'must_exclude_input')?.kind).toBe('text');
  });

  it('returns null for legacy L1/L2 rubrics', () => {
    expect(l3ClientView({ criteria: ['A(10점)'] })).toBeNull();
    expect(l3ClientView({ raw: 'a | b' })).toBeNull();
    expect(l3ClientView(null)).toBeNull();
  });
});

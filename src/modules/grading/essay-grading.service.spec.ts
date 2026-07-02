import { CertLevel, CertType, ExamPart } from '@prisma/client';
import { EssayGradingService } from './essay-grading.service';
import { L3PracticalGraderService } from './l3-practical-grader.service';
import type {
  ClaudeEssayGraderService,
  EssayGradeResult,
} from '../../integrations/anthropic/claude-essay-grader.service';
import type { CodeGradingService } from './code-grading.service';
import type { PrismaService } from '../../common/prisma.service';

const 현업적용_RUBRIC = {
  practiceType: '현업적용형',
  answerKey: {
    ai_usable_tasks: ['보도자료 초안 작성', '회의록 요약'],
    human_review_points: ['수치 검증', '법적 표현 검토'],
    must_exclude_input: '고객 개인정보가 포함된 원본 명단',
    key_reason: '개인정보와 미확정 수치는 외부 AI 입력에서 제외하고 사람이 최종 검토해야 한다',
  },
  rubric: [
    { criterion: 'AI 활용 작업 선정', points: 3 },
    { criterion: '사람 검토 지점', points: 3 },
    { criterion: '제외 입력자료', points: 3 },
    { criterion: '근거', points: 1 },
  ],
};

const GOOD_REASON =
  '고객 개인정보와 미확정 수치는 외부 AI 입력에서 제외하고, 초안 작성만 AI로 처리한 뒤 담당자가 수치와 법적 표현을 최종 검토해야 개인정보 유출과 오류를 막을 수 있다.';

const PERFECT_L3_ANSWER = JSON.stringify({
  ai_usable_tasks: ['보도자료 초안 작성', '회의록 요약'],
  human_review_points: ['수치 검증', '법적 표현 검토'],
  must_exclude_input: '고객 개인정보가 포함된 원본 명단',
  short_reason: GOOD_REASON,
});

interface Task {
  id: string;
  title: string;
  part: ExamPart;
  points: number;
  rubric: unknown;
  certType: CertType;
  level: CertLevel;
  scenario: string;
  modelAnswer: null;
  benchmarkExcellent: null;
  benchmarkNormal: null;
  benchmarkBorderline: null;
  benchmarkFail: null;
  riskCriteria: null;
  forbiddenRules: null;
}

function makeTask(over: Partial<Task>): Task {
  return {
    id: 't1', title: '과제', part: ExamPart.PRACTICAL, points: 10, rubric: {},
    certType: CertType.AXIS, level: CertLevel.L3, scenario: '시나리오',
    modelAnswer: null, benchmarkExcellent: null, benchmarkNormal: null,
    benchmarkBorderline: null, benchmarkFail: null, riskCriteria: null, forbiddenRules: null,
    ...over,
  };
}

function makeAnswer(over: { taskId: string; contentText: string; part: ExamPart; aiChatLog?: unknown }) {
  return { id: `a-${over.taskId}`, expertScore: null, aiChatLog: null, ...over };
}

const CLAUDE_RESULT: EssayGradeResult = {
  criterionScores: [{ key: 'C1', label: 'x', maxPoints: 10, score: 8 }],
  total: 8, maxTotal: 10, pct: 80, band: 'normal', riskFlags: [], confidence: 0.85,
  rationale: 'ok', model: 'claude-opus-4-8', promptHash: 'h', latencyMs: 100, degraded: false,
};

function harness(session: unknown, tasks: unknown[], grade: jest.Mock = jest.fn(async () => CLAUDE_RESULT)) {
  const essayUpdate = jest.fn(async () => ({}));
  const sessionUpdate = jest.fn(async () => ({}));
  const prisma = {
    examSession: { findUnique: jest.fn(async () => session), update: sessionUpdate },
    taskTemplate: { findMany: jest.fn(async () => tasks) },
    essayAnswer: { update: essayUpdate },
  } as unknown as PrismaService;
  const grader = { isConfigured: () => true, grade } as unknown as ClaudeEssayGraderService;
  const code = { isCodeTask: () => false, autoGrade: jest.fn() } as unknown as CodeGradingService;
  const svc = new EssayGradingService(prisma, grader, code, new L3PracticalGraderService());
  return { svc, essayUpdate, sessionUpdate, grade };
}

const dataOf = (mock: jest.Mock, i = 0) => mock.mock.calls[i][0].data;

describe('EssayGradingService dispatcher', () => {
  it('L3 PRACTICAL with a strong answer → answer-key grader, no Claude call', async () => {
    const task = makeTask({ id: 'l3', rubric: 현업적용_RUBRIC });
    const session = { id: 's1', level: CertLevel.L3, essayAnswers: [makeAnswer({ taskId: 'l3', contentText: PERFECT_L3_ANSWER, part: ExamPart.PRACTICAL })] };
    const { svc, essayUpdate, sessionUpdate, grade } = harness(session, [task]);

    await svc.aiPrescoreSession('s1');

    expect(grade).not.toHaveBeenCalled();
    expect(dataOf(essayUpdate).aiModel).toBe('l3-answer-key');
    expect(dataOf(essayUpdate).earnedPoints).toBeGreaterThanOrEqual(9);
    expect(dataOf(sessionUpdate).mandatoryReview).toBe(false);
  });

  it('L3 PRACTICAL with a borderline rationale → hybrid (Claude rationale assist)', async () => {
    const task = makeTask({
      id: 'l3b', points: 10,
      rubric: {
        practiceType: '현업적용형',
        answerKey: { ai_usable_tasks: ['회의록 요약'], key_reason: '개인정보 수치 검토 필요' },
        rubric: [{ criterion: '작업 선정', points: 9 }, { criterion: '근거', points: 1 }],
      },
    });
    const answer = JSON.stringify({
      ai_usable_tasks: ['회의록 요약'],
      short_reason: '개인정보 보호를 위해 담당자가 신중하게 처리해야 하는 상황이라고 생각하며 충분히 대비해야 한다.',
    });
    const grade: jest.Mock = jest.fn(async () => ({
      ...CLAUDE_RESULT,
      criterionScores: [{ key: 'C2', label: '근거', maxPoints: 1, score: 1 }],
      confidence: 0.82,
    }));
    const session = { id: 's2', level: CertLevel.L3, essayAnswers: [makeAnswer({ taskId: 'l3b', contentText: answer, part: ExamPart.PRACTICAL })] };
    const { svc, essayUpdate, grade: g } = harness(session, [task], grade);

    await svc.aiPrescoreSession('s2');

    expect(g).toHaveBeenCalledTimes(1); // ONLY the rationale criterion
    expect(g.mock.calls[0][0].criteria).toHaveLength(1);
    expect(dataOf(essayUpdate).aiModel).toBe('hybrid-l3+claude');
  });

  it('L2 PRACTICAL → Claude rubric grader, aiChatLog included', async () => {
    const task = makeTask({ id: 'l2', level: CertLevel.L2, rubric: { criteria: ['평가(10점)'] } });
    const chat = [{ role: 'user', text: 'hi' }];
    const session = { id: 's3', level: CertLevel.L2, essayAnswers: [makeAnswer({ taskId: 'l2', contentText: '자유 서술 답안', part: ExamPart.PRACTICAL, aiChatLog: chat })] };
    const { svc, essayUpdate, grade } = harness(session, [task]);

    await svc.aiPrescoreSession('s3');

    expect(grade).toHaveBeenCalledTimes(1);
    expect(grade.mock.calls[0][1].aiChatLog).toEqual(chat);
    expect(dataOf(essayUpdate).aiModel).toBe('claude-opus-4-8');
  });

  it('L1 ESSAY → Claude grader with aiChatLog omitted', async () => {
    const task = makeTask({ id: 'e1', level: CertLevel.L1, part: ExamPart.ESSAY, rubric: { criteria: ['논리(20점)'] } });
    const session = { id: 's4', level: CertLevel.L1, essayAnswers: [makeAnswer({ taskId: 'e1', contentText: '에세이', part: ExamPart.ESSAY, aiChatLog: [{ role: 'user', text: 'x' }] })] };
    const { svc, grade } = harness(session, [task]);

    await svc.aiPrescoreSession('s4');

    expect(grade.mock.calls[0][1].aiChatLog).toBeUndefined();
  });

  it('L3 legacy free-text answer → Claude fallback + forced expert review', async () => {
    const task = makeTask({ id: 'l3leg', rubric: 현업적용_RUBRIC });
    const session = {
      id: 's6',
      level: CertLevel.L3,
      essayAnswers: [makeAnswer({ taskId: 'l3leg', contentText: '예전 방식의 자유서술 답안입니다.', part: ExamPart.PRACTICAL })],
    };
    const { svc, grade, sessionUpdate } = harness(session, [task]);

    await svc.aiPrescoreSession('s6');

    expect(grade).toHaveBeenCalledTimes(1); // structured parse failed → Claude
    expect(dataOf(sessionUpdate).mandatoryReview).toBe(true);
  });

  it('L3 risk-type low score → session mandatoryReview = true', async () => {
    const task = makeTask({
      id: 'risk',
      rubric: {
        practiceType: '리스크 판단형',
        answerKey: { highest_risk: '개인정보 외부 입력', immediate_action: '입력 중단', key_reason: '유출 위험' },
        rubric: [{ criterion: '위험 식별', points: 5 }, { criterion: '즉시 조치', points: 4 }, { criterion: '근거', points: 1 }],
      },
    });
    const answer = JSON.stringify({ highest_risk: '오탈자', immediate_action: '맞춤법 검사', short_reason: '문서를 다시 검토한다.' });
    const session = { id: 's5', level: CertLevel.L3, essayAnswers: [makeAnswer({ taskId: 'risk', contentText: answer, part: ExamPart.PRACTICAL })] };
    const { svc, sessionUpdate } = harness(session, [task]);

    await svc.aiPrescoreSession('s5');

    expect(dataOf(sessionUpdate).mandatoryReview).toBe(true);
  });
});

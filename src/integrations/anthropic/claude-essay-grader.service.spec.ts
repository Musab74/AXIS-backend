import { ConfigService } from '@nestjs/config';
import { ExamPart } from '@prisma/client';
import { ClaudeEssayGraderService, EssayGradeTask } from './claude-essay-grader.service';

/**
 * With no ANTHROPIC_API_KEY the grader runs "offline" (degraded=true) but still
 * computes the promptHash from the exact system+task+user text it WOULD send.
 * Since the system prompt now carries a part-specific channel, the promptHash
 * must differ per ExamPart for an otherwise-identical task/submission.
 */
function offlineGrader(): ClaudeEssayGraderService {
  const config = { get: () => undefined } as unknown as ConfigService;
  return new ClaudeEssayGraderService(config);
}

const TASK: EssayGradeTask = {
  title: '과제', scenario: '시나리오', points: 10,
  criteria: [{ key: 'C1', label: '종합', maxPoints: 10 }],
};
const SUBMISSION = { contentText: '응시자 답안' };

describe('ClaudeEssayGraderService — part-specific prompt', () => {
  const grader = offlineGrader();

  it('produces a distinct promptHash per ExamPart for the same task/submission', async () => {
    const practical = await grader.grade(TASK, SUBMISSION, ExamPart.PRACTICAL);
    const deliverable = await grader.grade(TASK, SUBMISSION, ExamPart.DELIVERABLE);
    const essay = await grader.grade(TASK, SUBMISSION, ExamPart.ESSAY);

    expect(practical.degraded).toBe(true); // offline (no API key)
    const hashes = [practical.promptHash, deliverable.promptHash, essay.promptHash];
    expect(new Set(hashes).size).toBe(3); // all three differ
  });

  it('is stable: same part → same promptHash', async () => {
    const a = await grader.grade(TASK, SUBMISSION, ExamPart.PRACTICAL);
    const b = await grader.grade(TASK, SUBMISSION, ExamPart.PRACTICAL);
    expect(a.promptHash).toBe(b.promptHash);
  });

  it('folds requiredStructure into the prompt (changes DELIVERABLE hash)', async () => {
    const withStructure: EssayGradeTask = { ...TASK, requiredStructure: '1.목표 2.거버넌스 3.KPI 4.리스크 …' };
    const base = await grader.grade(TASK, SUBMISSION, ExamPart.DELIVERABLE);
    const structured = await grader.grade(withStructure, SUBMISSION, ExamPart.DELIVERABLE);
    expect(structured.promptHash).not.toBe(base.promptHash);
  });
});

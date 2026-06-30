import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CertType, ExamPart, ExamSessionStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { Judge0Service, Judge0Result } from '../../integrations/judge0/judge0.service';
import { RedisService } from '../../integrations/redis/redis.service';
import { validateSourceCode } from './ast-validator';

export interface CodeRunInput {
  sourceCode: string;
  languageId: number;
  stdin?: string;
}

export interface TestCase {
  stdin: string;
  expectedOutput: string;
  label?: string;
}

export interface TestCaseResult {
  label: string;
  passed: boolean;
  expected: string;
  actual: string | null;
  statusDescription: string;
  time: string | null;
}

export interface RunResult {
  statusId: number;
  statusDescription: string;
  stdout: string | null;
  stderr: string | null;
  compileOutput: string | null;
  time: string | null;
  memory: number | null;
}

export interface TestResult {
  passed: number;
  total: number;
  cases: TestCaseResult[];
}

const MAX_RUNS_PER_SESSION = 30;
// TTL slightly longer than exam max (AXIS-C L2 = 120 min → 8000s to cover overlap)
const RUN_COUNTER_TTL = 8_000;

@Injectable()
export class SandboxService {
  private readonly logger = new Logger(SandboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly judge0: Judge0Service,
    private readonly redis: RedisService,
  ) {}

  private async assertEligible(userId: string, sessionId: string): Promise<void> {
    const session = await this.prisma.examSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');
    if (session.userId !== userId) throw new ForbiddenException();
    if (session.status !== ExamSessionStatus.IN_PROGRESS) {
      throw new BadRequestException('Exam not in progress');
    }
    if (session.hardDeadline && new Date() > session.hardDeadline) {
      throw new BadRequestException('Exam time has expired');
    }
    if (session.certType !== CertType.AXIS_C) {
      throw new BadRequestException('Code execution is only available for AXIS-C exams');
    }
  }

  private async checkRateLimit(sessionId: string): Promise<void> {
    const key = `sandbox:runs:${sessionId}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.set(key, '1', RUN_COUNTER_TTL);
    }
    if (count !== null && count > MAX_RUNS_PER_SESSION) {
      throw new HttpException(
        `Code execution limit reached (${MAX_RUNS_PER_SESSION} runs per session).`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private formatResult(raw: Judge0Result): RunResult {
    return {
      statusId: raw.statusId,
      statusDescription: raw.statusDescription,
      stdout: raw.stdout,
      stderr: raw.stderr,
      compileOutput: raw.compileOutput,
      time: raw.time,
      memory: raw.memory,
    };
  }

  /**
   * Run code without test cases — returns raw output. Used for candidates to
   * interactively test their solution before final submit.
   */
  async runCode(userId: string, sessionId: string, input: CodeRunInput): Promise<RunResult> {
    await this.assertEligible(userId, sessionId);
    await this.checkRateLimit(sessionId);
    validateSourceCode(input.sourceCode, input.languageId);

    const raw = await this.judge0.runWithTimeout({
      sourceCode: input.sourceCode,
      languageId: input.languageId,
      stdin: input.stdin,
    });

    this.logger.log(
      JSON.stringify({ msg: 'sandbox_run', sessionId, languageId: input.languageId, statusId: raw.statusId }),
    );
    return this.formatResult(raw);
  }

  /**
   * Run code against the task's sample test cases. Returns per-case pass/fail.
   * Uses the visible test cases from `TaskTemplate`; hidden test cases are only
   * evaluated on final submit.
   */
  async runTests(
    userId: string,
    sessionId: string,
    taskId: string,
    input: CodeRunInput,
  ): Promise<TestResult> {
    await this.assertEligible(userId, sessionId);
    await this.checkRateLimit(sessionId);
    validateSourceCode(input.sourceCode, input.languageId);

    const assigned = await this.prisma.essayAnswer.findUnique({
      where: { sessionId_taskId: { sessionId, taskId } },
    });
    if (!assigned) throw new BadRequestException('Task is not part of this exam session');

    const task = await this.prisma.taskTemplate.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');

    // Test cases for AXIS-C tasks are stored in the `rubric` Json column under
    // the key `testCases` (since `TaskTemplate` has no dedicated test-cases
    // column — it is added to rubric by the admin test-case upload endpoint).
    const rubric = task.rubric as { testCases?: unknown } | null;
    const rawCases = rubric?.testCases;
    const cases: TestCase[] = Array.isArray(rawCases) ? (rawCases as TestCase[]) : [];
    if (cases.length === 0) {
      throw new BadRequestException('No sample test cases available for this task');
    }

    const results: TestCaseResult[] = [];
    let passed = 0;

    for (let i = 0; i < cases.length; i++) {
      const tc = cases[i];
      const raw = await this.judge0.runWithTimeout({
        sourceCode: input.sourceCode,
        languageId: input.languageId,
        stdin: tc.stdin,
        expectedOutput: tc.expectedOutput,
      });
      const actual = raw.stdout?.trimEnd() ?? null;
      const expected = tc.expectedOutput.trimEnd();
      const ok = raw.statusId === 3 && actual === expected;
      if (ok) passed++;
      results.push({
        label: tc.label ?? `Case ${i + 1}`,
        passed: ok,
        expected,
        actual,
        statusDescription: raw.statusDescription,
        time: raw.time,
      });
    }

    this.logger.log(
      JSON.stringify({ msg: 'sandbox_test', sessionId, taskId, passed, total: cases.length }),
    );
    return { passed, total: cases.length, cases: results };
  }

  /**
   * Final code submission. Saves the source code to `EssayAnswer.contentText`
   * (which the grader views as the submitted solution) and runs against all
   * test cases (visible + hidden if present in `TaskTemplate.testCases`).
   * After submit, the candidate can still re-submit before the exam ends.
   */
  async submitCode(
    userId: string,
    sessionId: string,
    taskId: string,
    input: CodeRunInput,
  ): Promise<{ message: string; result: RunResult; earnedPoints?: number }> {
    await this.assertEligible(userId, sessionId);
    validateSourceCode(input.sourceCode, input.languageId);

    const assigned = await this.prisma.essayAnswer.findUnique({
      where: { sessionId_taskId: { sessionId, taskId } },
    });
    if (!assigned) throw new BadRequestException('Task is not part of this exam session');

    const task = await this.prisma.taskTemplate.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.part !== ExamPart.PRACTICAL) {
      throw new BadRequestException('Code submit is only valid for PRACTICAL-part tasks');
    }

    const raw = await this.judge0.runWithTimeout({
      sourceCode: input.sourceCode,
      languageId: input.languageId,
    });

    // Persist the submitted code as the answer (contentText stores code for AXIS-C)
    await this.prisma.essayAnswer.update({
      where: { id: assigned.id },
      data: {
        contentText: input.sourceCode,
        version: { increment: 1 },
      },
    });

    this.logger.log(
      JSON.stringify({
        msg: 'sandbox_submit',
        sessionId,
        taskId,
        languageId: input.languageId,
        statusId: raw.statusId,
      }),
    );

    return {
      message: raw.statusId === 3 ? 'Code accepted' : 'Code submitted (check output for details)',
      result: this.formatResult(raw),
    };
  }
}

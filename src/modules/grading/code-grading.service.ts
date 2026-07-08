import { Injectable, Logger } from '@nestjs/common';
import { CertType, ExamPart, TaskTemplate } from '@prisma/client';
import { Judge0Service } from '../../integrations/judge0/judge0.service';
import type {
  EssayGradeResult,
  EssayGradeRiskFlag,
} from '../../integrations/anthropic/claude-essay-grader.service';
import type { GradingBand } from './grading-config';
import { GATE_RULES } from './grading-config';
import { scanForbiddenPatterns } from './forbidden-patterns';

interface CodeTestCase {
  stdin: string;
  expectedOutput: string;
  label?: string;
}

/** Shape of the AXIS-C bits authored into `TaskTemplate.rubric` (freeform Json). */
interface CodeRubric {
  testCases?: unknown;
  /** Judge0 language id the task is authored for (e.g. 71 = Python 3). */
  languageId?: unknown;
}

const MODEL_ID = 'judge0-autotest';

/**
 * Grading-time Judge0 auto-test for AXIS-C coding tasks (운영기획서: "코드 실행
 * 채점은 채점 단계에서 Judge0로 수행"). The candidate's final submission is
 * persisted as `EssayAnswer.contentText` during the exam WITHOUT scoring; this
 * service re-runs it here against the task's full test-case set (visible +
 * hidden) and produces a deterministic first-pass score. A human expert still
 * finalizes — any test mismatch raises a risk flag so the session is routed to
 * mandatory review ("expert on mismatch").
 */
@Injectable()
export class CodeGradingService {
  private readonly logger = new Logger(CodeGradingService.name);

  constructor(private readonly judge0: Judge0Service) {}

  /** True for an AXIS-C practical task that carries runnable Judge0 test cases. */
  isCodeTask(tpl: TaskTemplate): boolean {
    if (tpl.certType !== CertType.AXIS_C || tpl.part !== ExamPart.PRACTICAL) return false;
    return this.readTestCases(tpl).length > 0;
  }

  /**
   * True when Judge0 execution is available on this server. A code task that
   * cannot be executed must NEVER silently pass — the dispatcher forces
   * mandatory review when this is false (see EssayGradingService).
   */
  isJudge0Configured(): boolean {
    return this.judge0.isConfigured();
  }

  private readTestCases(tpl: TaskTemplate): CodeTestCase[] {
    const rubric = tpl.rubric as CodeRubric | null;
    const raw = rubric?.testCases;
    return Array.isArray(raw) ? (raw as CodeTestCase[]) : [];
  }

  private readLanguageId(tpl: TaskTemplate): number | null {
    const rubric = tpl.rubric as CodeRubric | null;
    return typeof rubric?.languageId === 'number' ? rubric.languageId : null;
  }

  /**
   * Run the persisted code against every test case and build an EssayGradeResult.
   * Returns `null` (caller falls back to LLM/expert) when the task is not
   * auto-runnable — no language id, no test cases, no submitted code, or Judge0
   * is not configured on this server.
   */
  async autoGrade(tpl: TaskTemplate, code: string): Promise<EssayGradeResult | null> {
    if (!this.judge0.isConfigured()) return null;
    const cases = this.readTestCases(tpl);
    const languageId = this.readLanguageId(tpl);
    if (cases.length === 0 || languageId == null || !code.trim()) return null;

    const t0 = Date.now();
    let passed = 0;
    const perCase: string[] = [];
    for (let i = 0; i < cases.length; i++) {
      const tc = cases[i];
      const raw = await this.judge0.runWithTimeout({
        sourceCode: code,
        languageId,
        stdin: tc.stdin,
        expectedOutput: tc.expectedOutput,
      });
      const actual = raw.stdout?.trimEnd() ?? null;
      const ok = raw.statusId === 3 && actual === tc.expectedOutput.trimEnd();
      if (ok) passed++;
      perCase.push(`${tc.label ?? `Case ${i + 1}`}: ${ok ? 'PASS' : 'FAIL'}`);
    }

    const total = cases.length;
    const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
    const score = Math.round((pct / 100) * tpl.points);
    const allPassed = passed === total;
    const band: GradingBand = allPassed ? 'excellent' : pct >= 60 ? 'normal' : pct > 0 ? 'borderline' : 'fail';

    // Static forbidden-pattern scan runs alongside execution; a hit routes the
    // session to mandatory review even when every test passes.
    const staticFlags = scanForbiddenPatterns(code);
    const testFlags: EssayGradeRiskFlag[] = allPassed
      ? []
      : [{ code: 'code_tests_failed', severity: 'MED', detail: `${passed}/${total} 테스트 통과` }];

    this.logger.log(
      JSON.stringify({
        msg: 'code_autograde',
        taskId: tpl.id,
        languageId,
        passed,
        total,
        pct,
        forbiddenPatterns: staticFlags.length,
      }),
    );

    return {
      criterionScores: [
        { key: 'judge0', label: 'Judge0 자동 테스트 (통과/전체)', maxPoints: tpl.points, score },
      ],
      total: score,
      maxTotal: tpl.points,
      pct,
      band,
      // A mismatch (not all tests pass) must be seen by an expert per spec.
      riskFlags: [...staticFlags, ...testFlags],
      // Deterministic execution — the v2.0 gate/critical-fail contract does
      // not apply to Judge0 runs (no free text to contradict).
      gate: { triggered: false, rule: GATE_RULES.L2, contradiction: null },
      criticalFailCandidates: [],
      injectionSuspected: false,
      // Deterministic execution — high confidence in the pass/fail counts, but
      // never a 1.0 (the expert still judges code quality / partial credit).
      confidence: allPassed ? 0.95 : 0.7,
      rationale: `Judge0 자동 채점: ${passed}/${total} 테스트 통과 (${pct}%). ${perCase.join(' · ')}`,
      model: MODEL_ID,
      promptHash: `judge0:${languageId}:${total}`,
      promptVersion: 'judge0-autotest',
      latencyMs: Date.now() - t0,
      degraded: false,
    };
  }
}

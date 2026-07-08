/**
 * v2.0 (WP8) AI-grading baseline gate.
 *
 * AI-assisted grading may only run LIVE in production for a
 * (level, taskType, promptVersion) combination whose baseline protocol passed
 * (기획서 9-1 / 9-4 / L3 상세 11-3):
 *   1. 20+ anchor answers per task type across bands.
 *   2. 2–3 experts score independently → expert-expert variance per criterion.
 *   3. AI scores the same set; pass rule per criterion:
 *      |AI − expert| ≤ expert-expert variance.
 *   4. Failed criteria → ai_scored=false: excluded from AI scoring, expert
 *      direct scoring required.
 *   5. Re-baseline on any prompt/model/rubric/embedded-AI change; quarterly.
 *
 * Without a passed gate row, the grader runs in SHADOW mode: AI output is
 * persisted as reference (no earnedPoints prefill) and the session always
 * routes to the expert queue.
 *
 * Enforcement switch: `AI_GRADING_BASELINE_ENFORCED` (default 'false' so dev
 * environments and the current pre-launch pipeline keep working; production
 * MUST run with 'true' once v2.0 goes live — see README).
 */
import { Injectable, Logger } from '@nestjs/common';
import { CertLevel } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';

export interface BaselineGateStatus {
  /** True → AI scores may prefill earnedPoints; false → shadow mode. */
  live: boolean;
  /** Criterion labels that failed the per-criterion rule (expert-scored directly). */
  excludedCriteria: string[];
  /** Why the gate resolved this way (log/ops surface). */
  reason: 'enforcement_disabled' | 'gate_passed' | 'no_gate' | 'gate_failed';
}

function isEnforced(): boolean {
  return (process.env.AI_GRADING_BASELINE_ENFORCED || 'false').toLowerCase() === 'true';
}

@Injectable()
export class BaselineGateService {
  private readonly logger = new Logger(BaselineGateService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the gate for one task. Wildcard rows (taskType='*') cover every
   * type at the level; an exact-type row wins over the wildcard.
   */
  async status(
    level: CertLevel,
    taskType: string | null,
    promptVersion: string,
  ): Promise<BaselineGateStatus> {
    if (!isEnforced()) {
      return { live: true, excludedCriteria: [], reason: 'enforcement_disabled' };
    }
    const rows = await this.prisma.aiBaselineGate.findMany({
      where: {
        level,
        promptVersion,
        taskType: { in: [taskType ?? '*', '*'] },
      },
    });
    const exact = taskType ? rows.find((r) => r.taskType === taskType) : undefined;
    const gate = exact ?? rows.find((r) => r.taskType === '*');
    if (!gate) {
      this.logger.warn(
        JSON.stringify({ msg: 'baseline_gate_missing_shadow_mode', level, taskType, promptVersion }),
      );
      return { live: false, excludedCriteria: [], reason: 'no_gate' };
    }
    const excluded = Array.isArray(gate.aiExcludedCriteria)
      ? (gate.aiExcludedCriteria as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    return gate.passed
      ? { live: true, excludedCriteria: excluded, reason: 'gate_passed' }
      : { live: false, excludedCriteria: excluded, reason: 'gate_failed' };
  }

  /** Admin list (ops view of what is live vs shadow). */
  list(level?: CertLevel) {
    return this.prisma.aiBaselineGate.findMany({
      where: level ? { level } : undefined,
      orderBy: [{ level: 'asc' }, { taskType: 'asc' }, { promptVersion: 'asc' }],
    });
  }

  /** Admin upsert — records the baseline outcome for one combination. */
  async upsert(input: {
    level: CertLevel;
    taskType: string;
    promptVersion: string;
    passed: boolean;
    aiExcludedCriteria?: string[];
    notes?: string;
  }) {
    const data = {
      passed: input.passed,
      aiExcludedCriteria: input.aiExcludedCriteria ?? [],
      notes: input.notes ?? null,
      validatedAt: new Date(),
    };
    return this.prisma.aiBaselineGate.upsert({
      where: {
        level_taskType_promptVersion: {
          level: input.level,
          taskType: input.taskType,
          promptVersion: input.promptVersion,
        },
      },
      create: {
        level: input.level,
        taskType: input.taskType,
        promptVersion: input.promptVersion,
        ...data,
      },
      update: data,
    });
  }
}

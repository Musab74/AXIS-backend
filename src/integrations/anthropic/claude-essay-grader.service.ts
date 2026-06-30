import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import type { GradingBand, RiskSeverity } from '../../modules/grading/grading-config';
import type { RubricCriterion } from '../../modules/grading/rubric';

export interface EssayGradeTask {
  title: string;
  scenario: string;
  /** Parsed, weighted rubric criteria (see parseRubric). */
  criteria: RubricCriterion[];
  /** Authoritative max points for the task (TaskTemplate.points). */
  points: number;
  modelAnswer?: string | null;
  benchmarkExcellent?: string | null;
  benchmarkNormal?: string | null;
  benchmarkBorderline?: string | null;
  benchmarkFail?: string | null;
  riskCriteria?: string | null;
  forbiddenRules?: string | null;
}

export interface EssayGradeSubmission {
  contentText: string;
  /** EssayAnswer.aiChatLog — the in-exam assistant transcript, scanned for prohibited use. */
  aiChatLog?: unknown;
}

export interface EssayGradeCriterionScore {
  key: string;
  label: string;
  maxPoints: number;
  score: number;
}

export interface EssayGradeRiskFlag {
  code: string;
  severity: RiskSeverity;
  detail: string;
}

export interface EssayGradeResult {
  criterionScores: EssayGradeCriterionScore[];
  /** Sum of clamped per-criterion scores. */
  total: number;
  maxTotal: number;
  /** round(total / maxTotal * 100) — the practical-task percentage. */
  pct: number;
  band: GradingBand;
  riskFlags: EssayGradeRiskFlag[];
  confidence: number;
  rationale: string;
  model: string;
  promptHash: string;
  latencyMs: number;
  /** True when Claude was unavailable or threw — caller keeps the answer manual. */
  degraded: boolean;
}

// Grading quality is the whole point of the first pass, so use the flagship
// model (same choice as the in-exam assistant). Larger token budget than the
// proctor verifier because the rationale + per-criterion output is substantial.
const MODEL_ID = 'claude-opus-4-8';
const TIMEOUT_MS = 60_000;
const MAX_TOKENS = 2_500;

const SYSTEM_PROMPT = `당신은 AXIS 실무 자격시험(AXIS / AXIS-C / AXIS-H)의 AI 1차 채점관입니다. 응시자가 제출한 실기 답안(업무 결과물/서술형)을 주어진 루브릭 기준에 따라 채점하고, 리스크 플래그를 탐지합니다. 당신의 점수는 1차 참고용이며, 사람 채점위원이 최종 확정합니다.

채점 원칙:
- 각 루브릭 기준(criterion)별로 0점부터 해당 기준의 만점(maxPoints)까지 정수로 채점하세요. 만점을 초과하지 마세요.
- 제공된 기준 답안(modelAnswer)과 수준별 예시답안(benchmark: excellent/normal/borderline/fail)을 기준점(anchor)으로 삼아 일관되게 채점하세요.
- 근거 없이 후하게 주지 마세요. 빈 답안이나 무관한 답안은 0점에 가깝게 채점합니다.
- 한국어로 간결하고 사실 위주의 채점 근거(rationale)를 작성하세요.

리스크 플래그(riskFlags) — 다음과 같은 '치명적 실패 패턴'을 반드시 탐지하세요:
- 개인정보·고객명단·도면·미공개 수치 등 민감정보를 외부 AI에 입력하거나 답안에 무단 노출한 정황 (HIGH)
- 과제에서 금지한 외부 AI 도구 사용 정황 (forbiddenRules 참고) (HIGH)
- 근거 없는 수치·사실 날조(fabrication) (MED)
- 과제 요구 구성/조건의 중대한 누락 (LOW~MED)
탐지된 항목이 없으면 riskFlags는 빈 배열로 둡니다. aiChatLog(시험 중 AI 어시스턴트 대화 기록)도 함께 검토하세요.

confidence(0~1): 채점 확신도를 정직하게 보고하세요. 답안이 모호하거나 루브릭 적용이 애매하면 낮게 보고합니다.

반드시 \`submit_grading\` 도구로만 결과를 제출하세요.`;

const GRADING_TOOL = {
  name: 'submit_grading',
  description: 'Submit the AI first-pass grading verdict for one practical/essay answer.',
  input_schema: {
    type: 'object' as const,
    required: ['criterionScores', 'predictedBand', 'riskFlags', 'confidence', 'rationale'] as string[],
    properties: {
      criterionScores: {
        type: 'array' as const,
        description: 'One entry per rubric criterion key provided in the prompt.',
        items: {
          type: 'object' as const,
          required: ['key', 'score'] as string[],
          properties: {
            key: { type: 'string' as const },
            score: { type: 'number' as const },
          },
        },
      },
      predictedBand: {
        type: 'string' as const,
        enum: ['excellent', 'normal', 'borderline', 'fail'],
      },
      riskFlags: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          required: ['code', 'severity', 'detail'] as string[],
          properties: {
            code: { type: 'string' as const, maxLength: 64 },
            severity: { type: 'string' as const, enum: ['LOW', 'MED', 'HIGH'] },
            detail: { type: 'string' as const, maxLength: 240 },
          },
        },
      },
      confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
      rationale: { type: 'string' as const, maxLength: 2000 },
    },
  },
};

@Injectable()
export class ClaudeEssayGraderService {
  private readonly logger = new Logger(ClaudeEssayGraderService.name);
  private readonly client: Anthropic | null;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ai.anthropicApiKey');
    if (!apiKey) {
      this.logger.warn('ANTHROPIC_API_KEY missing — ClaudeEssayGraderService is offline.');
      this.client = null;
      return;
    }
    this.client = new Anthropic({ apiKey });
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  /**
   * Produce an AI first-pass grade for one practical/essay answer, grounded in
   * the task rubric and anchor exemplars. Never throws — returns
   * `{ degraded: true }` so manual grading always remains possible.
   */
  async grade(task: EssayGradeTask, submission: EssayGradeSubmission): Promise<EssayGradeResult> {
    const maxTotal = task.criteria.reduce((s, c) => s + c.maxPoints, 0) || task.points;
    const t0 = Date.now();

    const taskContext = this.buildTaskContext(task);
    const userContent = this.buildUserContent(task, submission);
    const promptHash = createHash('sha256')
      .update(SYSTEM_PROMPT)
      .update(taskContext)
      .update(userContent)
      .digest('hex')
      .slice(0, 16);

    const offline = (): EssayGradeResult => ({
      criterionScores: task.criteria.map((c) => ({ ...c, score: 0 })),
      total: 0,
      maxTotal,
      pct: 0,
      band: 'fail',
      riskFlags: [],
      confidence: 0,
      rationale: '',
      model: MODEL_ID,
      promptHash,
      latencyMs: Date.now() - t0,
      degraded: true,
    });

    if (!this.client) return offline();

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await this.client.beta.messages.create(
        {
          model: MODEL_ID,
          max_tokens: MAX_TOKENS,
          system: [
            { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: taskContext, cache_control: { type: 'ephemeral' } },
          ],
          tools: [{ ...GRADING_TOOL, cache_control: { type: 'ephemeral' } }],
          tool_choice: { type: 'tool', name: 'submit_grading' },
          messages: [{ role: 'user', content: userContent }],
        },
        { signal: ac.signal },
      );
      clearTimeout(timer);

      const verdict = this.extractToolUse(res.content);
      if (!verdict) {
        this.logger.warn(`Essay grader returned no tool_use (task=${task.title})`);
        return offline();
      }

      const result = this.normalise(verdict, task, maxTotal, promptHash, Date.now() - t0);
      this.logger.log(
        JSON.stringify({
          msg: 'essay_ai_graded',
          model: MODEL_ID,
          promptHash,
          confidence: result.confidence,
          pct: result.pct,
          band: result.band,
          riskFlags: result.riskFlags.length,
          latencyMs: result.latencyMs,
        }),
      );
      return result;
    } catch (err) {
      clearTimeout(timer);
      this.logger.warn(`Essay grader failed (task=${task.title}): ${(err as Error).message}`);
      return { ...offline(), latencyMs: Date.now() - t0 };
    }
  }

  private buildTaskContext(task: EssayGradeTask): string {
    const criteriaText = task.criteria
      .map((c) => `- ${c.key} (만점 ${c.maxPoints}점): ${c.label}`)
      .join('\n');
    const benchmarks = [
      ['최우수(excellent) 예시', task.benchmarkExcellent],
      ['보통(normal) 예시', task.benchmarkNormal],
      ['경계(borderline) 예시', task.benchmarkBorderline],
      ['미달(fail) 예시', task.benchmarkFail],
    ]
      .filter(([, v]) => v)
      .map(([k, v]) => `[${k}]\n${v}`)
      .join('\n\n');

    return (
      `[과제] ${task.title}\n\n[시나리오]\n${task.scenario}\n\n` +
      `[루브릭 기준] (각 기준 key별로 채점)\n${criteriaText}\n\n` +
      (task.modelAnswer ? `[기준 답안]\n${task.modelAnswer}\n\n` : '') +
      (benchmarks ? `[수준별 예시답안]\n${benchmarks}\n\n` : '') +
      (task.riskCriteria ? `[리스크 채점 기준]\n${task.riskCriteria}\n\n` : '') +
      (task.forbiddenRules ? `[금지 사항]\n${task.forbiddenRules}\n` : '')
    );
  }

  private buildUserContent(task: EssayGradeTask, submission: EssayGradeSubmission): string {
    const keys = task.criteria.map((c) => c.key).join(', ');
    const chatLog = this.summariseChatLog(submission.aiChatLog);
    return (
      `다음 응시자 답안을 위 루브릭에 따라 채점하세요. criterionScores에는 반드시 ` +
      `다음 key를 모두 포함하세요: ${keys}.\n\n` +
      `[응시자 답안]\n${submission.contentText?.trim() || '(빈 답안)'}\n\n` +
      `[시험 중 AI 어시스턴트 대화 기록]\n${chatLog}`
    );
  }

  private summariseChatLog(log: unknown): string {
    if (!Array.isArray(log) || log.length === 0) return '(기록 없음)';
    return log
      .slice(-20)
      .map((turn) => {
        const t = turn as { role?: string; text?: string };
        const role = t.role === 'assistant' ? 'AI' : '응시자';
        return `${role}: ${String(t.text ?? '').slice(0, 500)}`;
      })
      .join('\n');
  }

  private normalise(
    verdict: RawVerdict,
    task: EssayGradeTask,
    maxTotal: number,
    promptHash: string,
    latencyMs: number,
  ): EssayGradeResult {
    const scoreByKey = new Map(verdict.criterionScores.map((c) => [c.key, c.score]));
    const criterionScores: EssayGradeCriterionScore[] = task.criteria.map((c) => {
      const raw = scoreByKey.get(c.key);
      const score = clamp(typeof raw === 'number' ? Math.round(raw) : 0, 0, c.maxPoints);
      return { ...c, score };
    });
    const total = criterionScores.reduce((s, c) => s + c.score, 0);
    const pct = maxTotal > 0 ? Math.round((total / maxTotal) * 100) : 0;
    const riskFlags = verdict.riskFlags
      .filter((f) => f && typeof f.code === 'string')
      .map((f) => ({
        code: f.code.slice(0, 64),
        severity: (['LOW', 'MED', 'HIGH'].includes(f.severity) ? f.severity : 'LOW') as RiskSeverity,
        detail: String(f.detail ?? '').slice(0, 240),
      }));

    return {
      criterionScores,
      total,
      maxTotal,
      pct,
      band: verdict.predictedBand,
      riskFlags,
      confidence: clamp(verdict.confidence, 0, 1),
      rationale: String(verdict.rationale ?? '').slice(0, 2000),
      model: MODEL_ID,
      promptHash,
      latencyMs,
      degraded: false,
    };
  }

  private extractToolUse(content: Anthropic.Beta.Messages.BetaContentBlock[]): RawVerdict | null {
    const block = content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use' || block.name !== 'submit_grading') return null;
    const input = block.input as Record<string, unknown>;
    const band = input.predictedBand;
    if (band !== 'excellent' && band !== 'normal' && band !== 'borderline' && band !== 'fail') {
      return null;
    }
    const criterionScores = Array.isArray(input.criterionScores)
      ? (input.criterionScores as Array<Record<string, unknown>>)
          .filter((c) => typeof c.key === 'string' && typeof c.score === 'number')
          .map((c) => ({ key: c.key as string, score: c.score as number }))
      : [];
    const riskFlags = Array.isArray(input.riskFlags)
      ? (input.riskFlags as Array<Record<string, unknown>>).map((f) => ({
          code: String(f.code ?? ''),
          severity: String(f.severity ?? 'LOW'),
          detail: String(f.detail ?? ''),
        }))
      : [];
    return {
      criterionScores,
      predictedBand: band,
      riskFlags,
      confidence: typeof input.confidence === 'number' ? input.confidence : 0,
      rationale: typeof input.rationale === 'string' ? input.rationale : '',
    };
  }
}

interface RawVerdict {
  criterionScores: Array<{ key: string; score: number }>;
  predictedBand: GradingBand;
  riskFlags: Array<{ code: string; severity: string; detail: string }>;
  confidence: number;
  rationale: string;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

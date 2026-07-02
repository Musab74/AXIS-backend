/**
 * Pure routing + result-mapping helpers for the EssayGradingService dispatcher.
 *
 * `planGrading` picks the grading path from (level, part, isCodeTask); the
 * `*ToPersist` mappers flatten either grader's output into the common
 * EssayAnswer write payload; `mergeRationale` folds a Claude rationale-only
 * second pass back into an L3 answer-key result.
 */
import { CertLevel, ExamPart } from '@prisma/client';
import type { EssayGradeResult } from '../../integrations/anthropic/claude-essay-grader.service';
import type { L3GradeResult } from './l3-practical-grader.types';
import { round2 } from './l3-text-match';

export type GradingStrategyName = 'l3_answer_key' | 'claude_rubric' | 'code_autograde';

export interface GradingPlan {
  strategy: 'l3_answer_key' | 'claude_rubric';
  /** aiChatLog is scored for practical/deliverable; ESSAY is AI-forbidden. */
  includeChatLog: boolean;
  /** AXIS-C code tasks attach a Judge0 execution summary to the Claude context. */
  includeExecutionSummary: boolean;
}

/** The common shape written to EssayAnswer, regardless of which grader produced it. */
export interface EssayGradePersist {
  pct: number;
  earnedPoints: number;
  rationale: string;
  criterionScores: unknown;
  riskFlags: unknown;
  band: string;
  confidence: number;
  model: string;
  promptHash: string | null;
  latencyMs: number | null;
}

/**
 * Decide the grading path. L3 practicals are answer-key graded; everything else
 * (L2 practicals, L1 deliverable/essay, AXIS-C code) goes to the Claude rubric
 * grader with the appropriate context toggles.
 */
export function planGrading(input: {
  level: CertLevel;
  part: ExamPart;
  isCodeTask: boolean;
}): GradingPlan {
  const { level, part, isCodeTask } = input;
  if (level === CertLevel.L3 && part === ExamPart.PRACTICAL) {
    return { strategy: 'l3_answer_key', includeChatLog: false, includeExecutionSummary: false };
  }
  return {
    strategy: 'claude_rubric',
    includeChatLog: part !== ExamPart.ESSAY,
    includeExecutionSummary: isCodeTask,
  };
}

/** Heuristic: does the submission look like source code (for the Judge0 context hook)? */
export function looksLikeCode(text: string): boolean {
  return /(^\s*(def |function |class |import |#include)|=>|;\s*$|\{\s*$)/m.test(text ?? '');
}

/**
 * AXIS-C code tasks: surface the Judge0 execution captured during the exam so
 * Claude can weigh runtime pass/fail. Judge0 session-result persistence is not
 * wired yet, so this returns null today (stub hook) — the plumbing is ready.
 */
export function buildCodeExecutionSummary(
  session: { judge0Results?: Record<string, string>; [key: string]: unknown },
  taskId: string,
  contentText: string,
): string | null {
  if (!looksLikeCode(contentText)) return null;
  return session.judge0Results?.[taskId] ?? null;
}

export function bandFromPct(pct: number): 'excellent' | 'normal' | 'borderline' | 'fail' {
  if (pct >= 80) return 'excellent';
  if (pct >= 60) return 'normal';
  if (pct >= 50) return 'borderline';
  return 'fail';
}

/** Objective sub-scores rendered for the focused Claude rationale-assist prompt. */
export function objectiveContext(l3: L3GradeResult): string {
  const lines = l3.breakdown.details
    .filter((d) => d.kind === 'objective')
    .map((d) => `- ${d.key}: ${d.earned}/${d.points}점 (일치도 ${Math.round(d.matchRatio * 100)}%)`);
  return `객관식/체크리스트 채점 결과 (${l3.breakdown.objectiveScore}점):\n${lines.join('\n')}`;
}

/** Human-readable breakdown persisted to EssayAnswer.aiRationale for an L3 answer. */
export function buildL3Rationale(l3: L3GradeResult, aiModel: string): string {
  const parts = [
    `자동 채점(정답 키 기반). 총점 ${l3.earnedPoints}점 (${l3.pct}%).`,
    `- 객관식/체크리스트: ${l3.breakdown.objectiveScore}점`,
    `- 근거(서술): ${l3.breakdown.rationaleScore}점`,
  ];
  for (const d of l3.breakdown.details) {
    parts.push(
      `  · ${d.key}: ${d.earned}/${d.points} (${Math.round(d.matchRatio * 100)}%)${d.note ? ` — ${d.note}` : ''}`,
    );
  }
  if (l3.riskFlags.length) {
    parts.push(`리스크: ${l3.riskFlags.map((f) => `${f.code}(${f.severity})`).join(', ')}`);
  }
  if (aiModel === 'hybrid-l3+claude') parts.push('근거(서술) 항목은 Claude 보조 채점(hybrid)으로 재평가되었습니다.');
  if (l3.needsExpertReview) parts.push('⚠ 전문가 재검토 대상.');
  return parts.join('\n');
}

interface L3CriterionScoreJson {
  key: string;
  label: string;
  maxPoints: number;
  score: number;
  matchRatio: number;
  kind: 'objective' | 'rationale';
}

/** Per-criterion JSON for EssayAnswer.aiCriterionScores from an L3 breakdown. */
export function l3CriterionScores(l3: L3GradeResult): L3CriterionScoreJson[] {
  return l3.breakdown.details.map((d) => ({
    key: d.key,
    label: d.key,
    maxPoints: d.points,
    score: d.earned,
    matchRatio: d.matchRatio,
    kind: d.kind,
  }));
}

export function l3ToPersist(l3: L3GradeResult, aiModel: string, confidence: number): EssayGradePersist {
  return {
    pct: l3.pct,
    earnedPoints: Math.round(l3.earnedPoints),
    rationale: buildL3Rationale(l3, aiModel),
    criterionScores: l3CriterionScores(l3),
    riskFlags: l3.riskFlags,
    band: bandFromPct(l3.pct),
    confidence,
    model: aiModel,
    promptHash: null,
    latencyMs: null,
  };
}

export function claudeToPersist(res: EssayGradeResult): EssayGradePersist {
  return {
    pct: res.pct,
    earnedPoints: Math.round(res.total),
    rationale: res.rationale,
    criterionScores: res.criterionScores,
    riskFlags: res.riskFlags,
    band: res.band,
    confidence: res.confidence,
    model: res.model,
    promptHash: res.promptHash,
    latencyMs: res.latencyMs,
  };
}

/**
 * Fold a Claude rationale-only second pass into an L3 result: replace the
 * rationale criterion score, recompute total/pct, keep objective + risk data.
 */
export function mergeRationale(l3: L3GradeResult, claudeRes: EssayGradeResult, maxTotal: number): L3GradeResult {
  const claudeScore = claudeRes.criterionScores.reduce((s, c) => s + c.score, 0);
  const rationaleDetail = l3.breakdown.details.find((d) => d.kind === 'rationale');
  const rationaleMax = rationaleDetail?.points ?? 0;
  const newRationaleScore = Math.max(0, Math.min(rationaleMax, round2(claudeScore)));
  const earnedPoints = Math.max(0, Math.min(maxTotal, round2(l3.breakdown.objectiveScore + newRationaleScore)));
  const pct = maxTotal > 0 ? Math.round((earnedPoints / maxTotal) * 100) : 0;
  const details = l3.breakdown.details.map((d) =>
    d.kind === 'rationale' ? { ...d, earned: newRationaleScore, note: `${d.note ?? ''} · Claude 보정` } : d,
  );
  return {
    ...l3,
    earnedPoints,
    pct,
    breakdown: { ...l3.breakdown, rationaleScore: newRationaleScore, details },
  };
}

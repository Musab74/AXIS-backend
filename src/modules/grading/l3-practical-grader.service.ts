import { Injectable } from '@nestjs/common';
import type {
  EssayGradeGate,
  EssayGradeRiskFlag,
} from '../../integrations/anthropic/claude-essay-grader.service';
import { parseRubric, RubricCriterion } from './rubric';
import { GATE_RULES, GRADING_CONFIG, severityForRiskTag } from './grading-config';
import {
  charLength,
  detectSensitivePatterns,
  extractKeywords,
  hasNegationNear,
  keywordCoverage,
  round2,
  scoreChoice,
  scoreSet,
  toStringArray,
} from './l3-text-match';
import { L3GradeDetail, L3GradeResult, L3GradeTask, L3RubricPayload, L3Submission } from './l3-practical-grader.types';

export * from './l3-practical-grader.types';

/** L3 실습형 practical floor: 24/40 == 60% (운영기획서 §6/§10). */
const PRACTICAL_FLOOR_PCT = 60;

/** answerKey fields that are reference prose, not objective selections to score. */
const NON_OBJECTIVE_KEYS = new Set(['key_reason', 'example_prompt']);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Sum of the inner rubric[] points, falling back to 10 (the L3 task default). */
function deriveMaxPoints(rubric: unknown): number {
  const arr = asRecord(rubric)?.rubric;
  if (Array.isArray(arr)) {
    const sum = arr.reduce((s, c) => s + (typeof asRecord(c)?.points === 'number' ? (asRecord(c)!.points as number) : 0), 0);
    if (sum > 0) return sum;
  }
  return 10;
}

/**
 * Split the L3 rubric wrapper into the pieces the grader needs: the authoritative
 * answerKey, the weighted rubric criteria (via the shared parseRubric), and the
 * expected responseFormat. Safe on any shape — missing fields come back null.
 */
export function parseL3RubricPayload(rubric: unknown): L3RubricPayload {
  const wrapper = asRecord(rubric) ?? {};
  const fieldPointsRaw = asRecord(wrapper.fieldPoints);
  const fieldPoints = fieldPointsRaw
    ? Object.fromEntries(
        Object.entries(fieldPointsRaw).filter(([, v]) => typeof v === 'number' && v > 0),
      ) as Record<string, number>
    : null;
  const rcRaw = asRecord(wrapper.riskControl);
  const riskControl =
    rcRaw && typeof rcRaw.points === 'number'
      ? {
          points: rcRaw.points,
          penaltyPerHit: typeof rcRaw.penaltyPerHit === 'number' ? rcRaw.penaltyPerHit : 1,
        }
      : null;
  const generatedCriteria = Array.isArray(wrapper.generatedCriteria)
    ? (wrapper.generatedCriteria as Array<Record<string, unknown>>)
        .filter(
          (g) =>
            typeof g.label === 'string' &&
            typeof g.points === 'number' &&
            (g.kind === 'prompt_quality' || g.kind === 'verification_request'),
        )
        .map((g) => ({
          label: g.label as string,
          points: g.points as number,
          kind: g.kind as 'prompt_quality' | 'verification_request',
        }))
    : null;
  return {
    answerKey: asRecord(wrapper.answerKey),
    criteria: parseRubric(rubric, deriveMaxPoints(rubric)),
    responseFormat: asRecord(wrapper.responseFormat),
    fieldPoints: fieldPoints && Object.keys(fieldPoints).length ? fieldPoints : null,
    riskControl,
    generatedCriteria: generatedCriteria?.length ? generatedCriteria : null,
    mustNotChoose: toStringArray(wrapper.mustNotChoose),
    expertReviewTrigger: wrapper.expertReviewTrigger ?? null,
  };
}

const RATIONALE_KEYS = ['short_reason', 'rationale', 'reason', 'shortReason', '근거'];
const PROMPT_KEYS = ['write_prompt', 'writePrompt', 'prompt', 'example_prompt'];

function firstString(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    if (typeof obj[k] === 'string' && (obj[k] as string).trim()) return (obj[k] as string).trim();
  }
  return '';
}

/**
 * Decode the structured L3 answer stored as a JSON string in
 * EssayAnswer.contentText. Returns null for legacy free-text answers (or invalid
 * JSON), so the caller can fall back to the Claude essay grader.
 */
export function parseL3Submission(contentText: string): L3Submission | null {
  const raw = (contentText ?? '').trim();
  if (!raw || !(raw.startsWith('{') || raw.startsWith('['))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const obj = asRecord(parsed);
  if (!obj) return null;

  // The L3 exam UI submits a versioned envelope { version, selects: {...},
  // shortReason }. Older/flat payloads keep their objective fields at the top
  // level. Read selections from `selects` when present, else the top level.
  const rationale = firstString(obj, RATIONALE_KEYS);
  const promptText = firstString(obj, PROMPT_KEYS) || null;
  const reserved = new Set([...RATIONALE_KEYS, ...PROMPT_KEYS, 'selects', 'version']);
  const source = asRecord(obj.selects) ?? obj;
  const selections: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    if (!reserved.has(k)) selections[k] = v;
  }
  return { selections, rationale, promptText, raw: obj };
}

function normKey(k: string): string {
  return k.toLowerCase().replace(/[_\s-]/g, '');
}

/** Find the candidate value for an answerKey field, tolerating key casing/underscores. */
function lookupSelection(selections: Record<string, unknown>, key: string): unknown {
  if (key in selections) return selections[key];
  const nk = normKey(key);
  for (const [k, v] of Object.entries(selections)) {
    if (normKey(k) === nk) return v;
  }
  return undefined;
}

function firstCandidateString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length) return String(v[0]);
  return '';
}

/** Match ratio [0,1] of a candidate answer against one answerKey field. */
function scoreField(correct: unknown, candidate: unknown): number {
  if (Array.isArray(correct)) return scoreSet(toStringArray(correct), toStringArray(candidate));
  if (typeof correct === 'string') return scoreChoice(correct, firstCandidateString(candidate));
  return 0;
}

function objectiveFieldNames(answerKey: Record<string, unknown>): string[] {
  return Object.keys(answerKey).filter(
    (k) => !NON_OBJECTIVE_KEYS.has(k) && (Array.isArray(answerKey[k]) || typeof answerKey[k] === 'string'),
  );
}

function isRiskTypeItem(payload: L3RubricPayload): boolean {
  return (
    (payload.answerKey != null && 'highest_risk' in payload.answerKey) ||
    (payload.responseFormat != null && 'select_highest_risk' in payload.responseFormat)
  );
}

interface ObjectiveOutcome {
  score: number;
  ratio: number;
  details: L3GradeDetail[];
}
interface RationaleOutcome {
  score: number;
  coverage: number;
  borderline: boolean;
  detail: L3GradeDetail;
}

/**
 * Deterministic first-pass grader for L3 실습형 structured answers.
 *
 * Objective selections (choices/checklists) are scored against the task's
 * answerKey; the 80–150자 rationale criterion is scored by a simple length +
 * key-concept-coverage rubric. Expert-review triggers follow 운영기획서 §10-1.
 * A borderline rationale flags `needsClaudeRationaleAssist` so a Claude second
 * pass can be layered on later without changing this contract.
 */
@Injectable()
export class L3PracticalGraderService {
  gradeL3Practical(task: L3GradeTask, submission: L3Submission): L3GradeResult {
    const payload = parseL3RubricPayload(task.rubric);
    const answerKey = payload.answerKey ?? {};
    const maxTotal = payload.criteria.reduce((s, c) => s + c.maxPoints, 0) || task.points;
    const rationalePoints = this.rationalePoints(payload.criteria);

    // v2.0 (WP9): per-criterion splits from the 루브릭 v2.1 템플릿 when the
    // item declares them; v1.1 items keep the legacy even split (regression-safe).
    const generatedPoints = (payload.generatedCriteria ?? []).reduce((s, g) => s + g.points, 0);
    const riskControlPoints = payload.riskControl?.points ?? 0;
    const objectivePoints = Math.max(
      maxTotal - rationalePoints - generatedPoints - riskControlPoints,
      0,
    );

    const objective = this.scoreObjective(
      answerKey,
      submission.selections,
      objectivePoints,
      payload.fieldPoints,
    );
    const mustNotChooseHits = this.countMustNotChoose(payload.mustNotChoose, submission.selections);
    const riskControlDetail = payload.riskControl
      ? this.scoreRiskControl(payload.riskControl, mustNotChooseHits)
      : null;
    const generatedDetails = payload.generatedCriteria
      ? this.scoreGenerated(payload.generatedCriteria, submission, answerKey)
      : [];
    const rationale = this.scoreRationale(submission.rationale, answerKey, rationalePoints);

    const generatedScore = round2(generatedDetails.reduce((s, d) => s + d.earned, 0));
    const autoScore = round2(
      objective.score + (riskControlDetail?.earned ?? 0) + generatedScore,
    );
    const earnedPoints = Math.max(0, Math.min(maxTotal, round2(autoScore + rationale.score)));
    const pct = maxTotal > 0 ? Math.round((earnedPoints / maxTotal) * 100) : 0;
    const { flags, gate, needsExpertReview } = this.assessRisk({
      payload,
      submission,
      objectiveRatio: objective.ratio,
      coverage: rationale.coverage,
      pct,
      earnedPoints,
      taskPoints: task.points,
      mustNotChooseHits,
    });

    return {
      earnedPoints,
      pct,
      breakdown: {
        // Everything deterministic (selections + 위험통제 penalty + generated
        // text criteria) — the AI-assisted share is the rationale criterion.
        objectiveScore: autoScore,
        rationaleScore: rationale.score,
        details: [
          ...objective.details,
          ...(riskControlDetail ? [riskControlDetail] : []),
          ...generatedDetails,
          rationale.detail,
        ],
      },
      riskFlags: flags,
      gate,
      needsExpertReview,
      needsClaudeRationaleAssist: rationale.borderline,
    };
  }

  /** Count selected option codes/texts that appear in the must-not-choose list. */
  private countMustNotChoose(mustNotChoose: string[], selections: Record<string, unknown>): number {
    if (mustNotChoose.length === 0) return 0;
    const banned = new Set(mustNotChoose.map((v) => v.trim().toLowerCase()));
    let hits = 0;
    for (const value of Object.values(selections)) {
      for (const v of toStringArray(value)) {
        if (banned.has(v.trim().toLowerCase())) hits++;
      }
    }
    return hits;
  }

  /** 위험통제 (v2.0 현업적용형): base points minus penalty per banned selection, floor 0. */
  private scoreRiskControl(
    rc: { points: number; penaltyPerHit: number },
    hits: number,
  ): L3GradeDetail {
    const earned = Math.max(0, round2(rc.points - hits * rc.penaltyPerHit));
    return {
      key: 'risk_control',
      kind: 'risk_control',
      points: round2(rc.points),
      earned,
      matchRatio: rc.points > 0 ? round2(earned / rc.points) : 0,
      note: hits > 0 ? `금지 옵션 ${hits}건 선택 (−${rc.penaltyPerHit}/건)` : undefined,
    };
  }

  /**
   * v2.0 generated-text criteria (지시 보완 / 검증요청 / 검증절차):
   *   prompt_quality — keyword coverage of the candidate's 요청문/수정 지시문
   *   against the answer key's example prompt;
   *   verification_request — presence of an explicit 검증/점검 요청.
   * Deterministic first pass; borderline rationale still routes to the Claude
   * assist, and every band case lands in expert review via the usual triggers.
   */
  private scoreGenerated(
    criteria: NonNullable<L3RubricPayload['generatedCriteria']>,
    submission: L3Submission,
    answerKey: Record<string, unknown>,
  ): L3GradeDetail[] {
    const text = (submission.promptText ?? '').trim();
    const example =
      typeof answerKey.example_prompt === 'string' ? (answerKey.example_prompt as string) : '';
    return criteria.map((g) => {
      let ratio = 0;
      if (text) {
        ratio =
          g.kind === 'verification_request'
            ? /(검증|점검|확인|검토|표시)/.test(text)
              ? 1
              : 0
            : keywordCoverage(text, extractKeywords(example));
      }
      const earned = round2(g.points * ratio);
      return {
        key: g.label,
        kind: 'generated' as const,
        points: round2(g.points),
        earned,
        matchRatio: round2(ratio),
        note: text ? undefined : '생성 텍스트 없음',
      };
    });
  }

  /** Points on the "근거"/rationale criterion (typically 1); 0 if the rubric has none. */
  private rationalePoints(criteria: RubricCriterion[]): number {
    const c = criteria.find((x) => /근거|rationale|reason|이유|서술/i.test(x.label));
    return c?.maxPoints ?? 0;
  }

  private scoreObjective(
    answerKey: Record<string, unknown>,
    selections: Record<string, unknown>,
    objectivePoints: number,
    fieldPoints: Record<string, number> | null,
  ): ObjectiveOutcome {
    const fields = fieldPoints
      ? Object.keys(fieldPoints).filter((k) => k in answerKey || lookupSelection(selections, k) !== undefined)
      : objectiveFieldNames(answerKey);
    if (fields.length === 0 || objectivePoints <= 0) return { score: 0, ratio: 0, details: [] };

    // v2.0 per-criterion splits when declared (WP9); legacy even split otherwise.
    const per = objectivePoints / fields.length;
    const pointsOf = (key: string) => (fieldPoints ? fieldPoints[key] ?? 0 : per);
    const details: L3GradeDetail[] = [];
    let ratioSum = 0;
    for (const key of fields) {
      const ratio = scoreField(answerKey[key], lookupSelection(selections, key));
      ratioSum += ratio;
      const pts = pointsOf(key);
      details.push({ key, kind: 'objective', points: round2(pts), earned: round2(pts * ratio), matchRatio: round2(ratio) });
    }
    const score = round2(details.reduce((s, d) => s + d.earned, 0));
    return { score, ratio: ratioSum / fields.length, details };
  }

  private scoreRationale(
    rationale: string,
    answerKey: Record<string, unknown>,
    rationalePoints: number,
  ): RationaleOutcome {
    const text = rationale ?? '';
    const len = charLength(text);
    const lengthScore = len >= 80 && len <= 150 ? 1 : len >= 60 && len <= 180 ? 0.6 : len > 0 ? 0.3 : 0;
    const keyReason = typeof answerKey.key_reason === 'string' ? answerKey.key_reason : '';
    const coverage = keywordCoverage(text, extractKeywords(keyReason));
    const ratio = 0.4 * lengthScore + 0.6 * coverage;
    const score = round2(rationalePoints * ratio);
    const borderline = len > 0 && coverage >= 0.2 && coverage < 0.6;
    return {
      score,
      coverage,
      borderline,
      detail: {
        key: 'rationale',
        kind: 'rationale',
        points: round2(rationalePoints),
        earned: score,
        matchRatio: round2(ratio),
        note: `len=${len}, lengthScore=${lengthScore}, coverage=${round2(coverage)}`,
      },
    };
  }

  private assessRisk(ctx: {
    payload: L3RubricPayload;
    submission: L3Submission;
    objectiveRatio: number;
    coverage: number;
    pct: number;
    earnedPoints: number;
    taskPoints: number;
    mustNotChooseHits: number;
  }): { flags: EssayGradeRiskFlag[]; gate: EssayGradeGate; needsExpertReview: boolean } {
    const flags: EssayGradeRiskFlag[] = [];
    // Below the 24/40 floor, or within the pass-boundary band around it.
    let review =
      ctx.pct < PRACTICAL_FLOOR_PCT ||
      Math.abs(ctx.pct - PRACTICAL_FLOOR_PCT) <= GRADING_CONFIG.BOUNDARY_BAND_PCT;

    if (isRiskTypeItem(ctx.payload) && ctx.earnedPoints <= ctx.taskPoints / 2) {
      review = true;
      flags.push({ code: 'risk_item_low_score', severity: 'MED', detail: `리스크 판단형 저득점 (${ctx.earnedPoints}/${ctx.taskPoints})` });
    }
    // v2.0 (WP9): a banned option (금지 옵션) selection is 감점 + 플래그 + 검수
    // (개발자 명세서 통합 테스트 T4).
    if (ctx.mustNotChooseHits > 0) {
      review = true;
      flags.push({
        code: 'must_not_choose_selected',
        severity: 'MED',
        detail: `금지 옵션 선택 ${ctx.mustNotChooseHits}건 (감점 적용)`,
      });
    }
    // 선택-근거 일치 게이트 (v2.0 WP6): the heuristic contradiction check is
    // the deterministic gate arm (Claude assist can also raise it). The gate
    // only NOMINATES — zeroing the affected selection score is an
    // expert-confirmed action (admin-grading confirm-gate endpoint).
    const contradiction = this.contradicts(
      ctx.submission.rationale,
      ctx.payload.answerKey ?? {},
      ctx.objectiveRatio,
      ctx.coverage,
    );
    const gate: EssayGradeGate = {
      triggered: contradiction,
      rule: GATE_RULES.L3,
      contradiction: contradiction ? '근거 서술이 정답 선택과 상충하는 정황' : null,
    };
    if (contradiction) {
      review = true;
      flags.push({ code: 'rationale_contradiction', severity: 'MED', detail: '근거 서술이 정답 선택과 상충하는 정황' });
    }
    // PII/copyright regex hits map onto the L3 controlled vocabulary (WP6);
    // the matched pattern code is kept in `detail` for the reviewer.
    for (const hit of detectSensitivePatterns(ctx.submission.rationale)) {
      review = true;
      const tag = hit.kind === 'pii' ? '개인정보 입력' : '저작권 위험';
      flags.push({
        code: tag,
        severity: severityForRiskTag(tag),
        detail:
          hit.kind === 'pii'
            ? `근거 텍스트에서 개인정보 패턴 탐지 (${hit.code})`
            : '근거 텍스트에서 저작권 위험 패턴 탐지',
      });
    }
    return { flags, gate, needsExpertReview: review };
  }

  /** Mostly-correct selections but a rationale that shares nothing with — or negates — the key. */
  private contradicts(
    rationale: string,
    answerKey: Record<string, unknown>,
    objectiveRatio: number,
    coverage: number,
  ): boolean {
    const text = (rationale ?? '').trim();
    if (charLength(text) < 40) return false;
    if (objectiveRatio >= 0.6 && coverage === 0) return true;
    for (const [k, v] of Object.entries(answerKey)) {
      if (NON_OBJECTIVE_KEYS.has(k)) continue;
      if (typeof v === 'string' && hasNegationNear(text, v)) return true;
    }
    return false;
  }
}

/**
 * TaskTemplate.rubric normalisation.
 *
 * The seed pipeline (`seed-questions-csv.ts`) stores a task's rubric as JSON in
 * one of two shapes, depending on the source CSV:
 *   - { criteria: string[], maxPerCriterion?: number }   // line-per-criterion
 *   - { raw: string }                                     // unparseable blob
 *
 * Each criterion line is free Korean text that often embeds its own weight,
 * e.g. "전략 논리성(15점): 목표 선정·우선순위·근거". This maps the brief's fixed
 * R1–R8 / 55-pt rubric onto the platform's variable, per-task rubrics: we derive
 * a stable key (C1, C2, …), a human label, and a max-points weight per criterion.
 */
export interface RubricCriterion {
  key: string;
  label: string;
  maxPoints: number;
}

/**
 * The L3 실습형 (practical) reference material the seed writes into
 * TaskTemplate.rubric alongside the weighted criteria. Fed to the AI grader as
 * grading anchors (see parseL3Reference).
 */
export interface L3Reference {
  /** 현업적용형 / 지시설계형 / 분석·검증형 / 리스크 판단형. */
  practiceType: string | null;
  /** Expected answer shape (selections + short reason), serialized for the prompt. */
  responseFormat: string | null;
  /** Authoritative answer key — the grading ground truth, serialized. */
  answerKey: string | null;
  /** Task-level risk patterns to watch for, serialized. */
  riskFlags: string | null;
}

interface CriteriaShape {
  criteria: unknown;
  maxPerCriterion?: unknown;
}
interface RawShape {
  raw: unknown;
}

const WEIGHT_RE = /\((\d+)\s*점\)/; // "(15점)" → 15

/**
 * Parse a TaskTemplate.rubric JSON value into a list of weighted criteria whose
 * `maxPoints` sum to `taskPoints`. Always returns at least one criterion so the
 * AI scorer and the adjudication UI never face an empty rubric. `taskPoints` is
 * the task's authoritative max (TaskTemplate.points) used to scale/normalise.
 */
export function parseRubric(rubric: unknown, taskPoints: number): RubricCriterion[] {
  const lines = extractCriteriaLines(rubric);
  if (lines.length === 0) {
    return [{ key: 'C1', label: '종합 평가 (Overall)', maxPoints: Math.max(taskPoints, 1) }];
  }

  // Pull an explicit "(n점)" weight off each line where present.
  const withWeights = lines.map((label, i) => {
    const m = label.match(WEIGHT_RE);
    return { key: `C${i + 1}`, label, weight: m ? Number(m[1]) : null };
  });

  const explicitSum = withWeights.reduce((s, c) => s + (c.weight ?? 0), 0);
  const explicitCount = withWeights.filter((c) => c.weight != null).length;

  // If every line carried a weight and they sum to the task total, trust them.
  if (explicitCount === withWeights.length && explicitSum > 0) {
    return withWeights.map((c) => ({ key: c.key, label: c.label, maxPoints: c.weight! }));
  }

  // Otherwise distribute the task points evenly, honouring any explicit weights
  // first and splitting the remainder across the unweighted criteria.
  const remainingPoints = Math.max(taskPoints - explicitSum, 0);
  const unweighted = withWeights.length - explicitCount;
  const perUnweighted = unweighted > 0 ? Math.max(Math.floor(remainingPoints / unweighted), 1) : 0;

  return withWeights.map((c) => ({
    key: c.key,
    label: c.label,
    maxPoints: c.weight ?? (perUnweighted || Math.max(Math.floor(taskPoints / withWeights.length), 1)),
  }));
}

function extractCriteriaLines(rubric: unknown): string[] {
  if (!rubric || typeof rubric !== 'object') {
    return typeof rubric === 'string' ? splitLines(rubric) : [];
  }
  const asCriteria = rubric as CriteriaShape;
  if (Array.isArray(asCriteria.criteria)) {
    return asCriteria.criteria.map((c) => String(c).trim()).filter(Boolean);
  }
  // L3 실습형 wrapper: the weighted rubric lives in an inner `rubric` array of
  // { criterion, points, description } objects (seed-l3-practicals.ts).
  const asL3 = rubric as { rubric?: unknown };
  if (Array.isArray(asL3.rubric)) {
    return extractL3CriteriaLines(asL3.rubric);
  }
  const asRaw = rubric as RawShape;
  if (typeof asRaw.raw === 'string') {
    return splitLines(asRaw.raw);
  }
  return [];
}

/**
 * Turn the L3 wrapper's inner `rubric` array — `{ criterion, points, description }`
 * objects — into "핵심 판단(4점): …" criterion lines, so the shared "(n점)" weight
 * parser assigns each criterion its authored maxPoints instead of collapsing the
 * whole task into a single generic "Overall" criterion.
 */
function extractL3CriteriaLines(items: unknown[]): string[] {
  return items
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => {
      const label = String(c.criterion ?? c.label ?? '').trim();
      if (!label) return '';
      const pts = typeof c.points === 'number' ? c.points : null;
      const desc = typeof c.description === 'string' ? c.description.trim() : '';
      const head = pts != null ? `${label}(${pts}점)` : label;
      return desc ? `${head}: ${desc}` : head;
    })
    .filter(Boolean);
}

/**
 * Extract the L3 실습형 reference material (practice type, expected response
 * format, answer key, task risk flags) from the wrapper the L3 seed writes into
 * TaskTemplate.rubric. Returns null for legacy L1/L2 rubric shapes ({criteria}
 * or {raw}), so callers can spread the result without touching that path.
 */
export function parseL3Reference(rubric: unknown): L3Reference | null {
  if (!rubric || typeof rubric !== 'object' || Array.isArray(rubric)) return null;
  const r = rubric as Record<string, unknown>;
  // The L3 wrapper is the only shape carrying an inner `rubric` criteria array
  // together with a practiceType/answerKey; legacy rubrics have neither.
  const isL3 = Array.isArray(r.rubric) || 'answerKey' in r || 'practiceType' in r;
  if (!isL3) return null;
  return {
    practiceType: typeof r.practiceType === 'string' ? r.practiceType : null,
    responseFormat: serializeReference(r.responseFormat),
    answerKey: serializeReference(r.answerKey),
    riskFlags: serializeReference(r.riskFlags),
  };
}

/** Render a rubric sub-value as readable text for the grading prompt (Korean kept literal). */
function serializeReference(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n|\s\|\s/) // newline OR " | " separator used in some CSVs
    .map((l) => l.trim())
    .filter(Boolean);
}

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
  const asRaw = rubric as RawShape;
  if (typeof asRaw.raw === 'string') {
    return splitLines(asRaw.raw);
  }
  return [];
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n|\s\|\s/) // newline OR " | " separator used in some CSVs
    .map((l) => l.trim())
    .filter(Boolean);
}

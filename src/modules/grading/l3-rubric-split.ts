/**
 * Derive the L3 실습형 grading splits from the bank's `rubric_10_points`.
 *
 * The bank states only criterion names + points; the grader needs to know WHICH
 * input each criterion is scored from (`parseL3RubricPayload` expects
 * `fieldPoints` / `riskControl` / `generatedCriteria`). Without these the
 * generation field scores 0 and the must-not-choose penalty never fires.
 *
 * Classification, in order:
 *   근거              → rationale   (the grader derives this from the criteria list)
 *   위험통제           → riskControl (must-not-choose penalty)
 *   지시 보완/요청문    → generated: prompt_quality        ┐ only when the item HAS
 *   검증요청/검증절차   → generated: verification_request  ┘ a generation_field
 *   everything else   → objective   (scored from the selection fields)
 *
 * Objective criteria then map onto the selection-field keys IN ORDER. When there
 * are fewer criteria than fields, the last criterion's points split evenly across
 * the remaining fields — exactly how the bank is authored (현업적용형: 핵심 판단 4
 * → tasks; 자료·절차 2 → excluded_materials + review_point, 1 each).
 *
 * Verified against all 40 v3 items: every one reconstructs to exactly 10 points.
 * Shared by prisma/import-new-questions.ts and the exam E2E test so the stored
 * rubric and the tested rubric can never drift apart.
 */
export interface L3RubricSplit {
  fieldPoints: Record<string, number> | null;
  riskControl: { points: number; penaltyPerHit: number } | null;
  generatedCriteria: Array<{ label: string; points: number; kind: string }> | null;
}

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function splitL3Rubric(
  rubric10: unknown,
  responseFormat: Record<string, unknown>,
  answerKeyOrder: string[],
): L3RubricSplit {
  const list = Array.isArray(rubric10) ? rubric10.filter((c) => rec(c)) : [];
  if (!list.length) return { fieldPoints: null, riskControl: null, generatedCriteria: null };
  const hasGenerationField = rec(responseFormat.generation_field) != null;

  let riskControl: L3RubricSplit['riskControl'] = null;
  const generatedCriteria: NonNullable<L3RubricSplit['generatedCriteria']> = [];
  const objective: Array<{ label: string; points: number }> = [];

  for (const c of list) {
    const row = rec(c)!;
    const label = String(row.criterion ?? '').trim();
    const points = Number(row.points) || 0;
    if (!label || points <= 0) continue;
    const flat = label.replace(/[·\s]/g, '');

    if (flat.includes('근거')) continue; // rationale — grader computes it itself
    if (flat.includes('위험통제')) {
      riskControl = { points, penaltyPerHit: 1 };
      continue;
    }
    if (hasGenerationField) {
      // 검증요청 (지시설계형): "…점검 요청을 요청문에 포함" — did the candidate ASK
      // the AI to self-check? Scored by the verification-request detector.
      if (flat.includes('검증요청')) {
        generatedCriteria.push({ label, points, kind: 'verification_request' });
        continue;
      }
      // 지시 보완 / 검증절차 (분석검증형) — both are judged AGAINST the model
      // prompt: 검증절차's own description says "…(example_revision_prompt 기준)".
      // Scored by keyword coverage of the example, not by a verification regex.
      if (
        flat.includes('지시보완') ||
        flat.includes('요청문') ||
        flat.includes('프롬프트') ||
        flat.includes('검증절차')
      ) {
        generatedCriteria.push({ label, points, kind: 'prompt_quality' });
        continue;
      }
    }
    objective.push({ label, points });
  }

  const fieldPoints: Record<string, number> = {};
  const keys = answerKeyOrder;
  if (keys.length && objective.length) {
    if (objective.length >= keys.length) {
      keys.forEach((k, i) => (fieldPoints[k] = objective[i]?.points ?? 0));
      for (let i = keys.length; i < objective.length; i++) {
        fieldPoints[keys[keys.length - 1]] += objective[i].points;
      }
    } else {
      const head = objective.slice(0, -1);
      head.forEach((c, i) => (fieldPoints[keys[i]] = c.points));
      const rest = keys.slice(head.length);
      const last = objective[objective.length - 1].points;
      const each = Math.round((last / rest.length) * 100) / 100;
      rest.forEach((k) => (fieldPoints[k] = each));
    }
  }

  return {
    fieldPoints: Object.keys(fieldPoints).length ? fieldPoints : null,
    riskControl,
    generatedCriteria: generatedCriteria.length ? generatedCriteria : null,
  };
}

/**
 * The rubric wrapper stored on TaskTemplate.rubric for an L3 practical item.
 * Shared by the importer and the tests so they cannot drift.
 */
export function buildL3RubricWrapper(it: Record<string, any>, id: string, practiceType: string) {
  const ak = rec(it.answer_key) ?? {};
  const required = rec(ak.required_choices) ?? {};
  const responseFormat = rec(it.response_format) ?? {};
  // scoreGenerated keyword-matches the candidate's text against this; 분석검증형
  // names it `example_revision_prompt`. Normalize both to `example_prompt`.
  const examplePrompt =
    (typeof ak.example_prompt === 'string' && ak.example_prompt) ||
    (typeof ak.example_revision_prompt === 'string' && ak.example_revision_prompt) ||
    null;
  const split = splitL3Rubric(it.rubric_10_points, responseFormat, Object.keys(required));

  return {
    itemId: id,
    practiceType,
    evaluationArea: it.evaluation_area ?? null,
    difficulty: it.difficulty ?? null,
    responseFormat: it.response_format ?? null,
    answerKey: {
      ...required,
      ...(typeof ak.key_reason === 'string' ? { key_reason: ak.key_reason } : {}),
      ...(examplePrompt ? { example_prompt: examplePrompt } : {}),
    },
    mustNotChoose: Array.isArray(ak.must_not_choose) ? ak.must_not_choose : [],
    partialCreditRule: ak.partial_credit_rule ?? null,
    rubric: it.rubric_10_points ?? it.rubric ?? null,
    fieldPoints: split.fieldPoints,
    riskControl: split.riskControl,
    generatedCriteria: split.generatedCriteria,
    riskFlags: it.risk_flags ?? null,
    rubric_version: '3.0',
  };
}

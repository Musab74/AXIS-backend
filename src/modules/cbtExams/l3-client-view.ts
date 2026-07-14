/**
 * L3 실습형 render spec — PURE, no Nest DI.
 *
 * Lives apart from cbt-exams.service so the grading side can resolve option
 * codes → display text (for the AI prompt and for human reviewers) without
 * importing the whole exam-module graph.
 */
/**
 * One structured-answer input on the L3 실습형 form. `key` is the answerKey field
 * name the grader scores against (so the client's `selects` align exactly); it is
 * an identifier, NOT a correct value. `options` (when present) is the selectable
 * pool from responseFormat — correct + distractors, unmarked.
 */
export interface L3Field {
  key: string;
  label: string;
  /**
   * v3 kinds: `select` (option group, codes) · `generate` (요청문 textbox).
   * Legacy (v2 bank / seed data) kinds are kept so old items still render.
   */
  kind: 'select' | 'generate' | 'multi' | 'multiText' | 'single' | 'text' | 'prompt';
  /** Legacy option pool — plain strings, no codes. */
  options?: string[];
  /**
   * v3 option pool: the answer CODE the grader scores against + its display text.
   * Correct answers and distractors are interleaved and unmarked.
   */
  choices?: L3Option[];
  /** v3 `select_count` — 1 ⇒ single choice, N ⇒ pick exactly N (client caps at N). */
  selectCount?: number;
  maxLen?: number;
}

/** One selectable option: `code` is what the client submits, `text` is what it shows. */
export interface L3Option {
  code: string;
  text: string;
}

/** The answer-free L3 실습형 render spec derived from TaskTemplate.rubric. */
export interface L3ClientView {
  practiceType: string | null;
  fixedAiOutput: string | null;
  fields: L3Field[];
  reason: { min: number; max: number };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const L3_KEY_LABELS: Record<string, string> = {
  ai_usable_tasks: 'AI 활용 가능 작업',
  human_review_points: '사람 검토 지점',
  must_exclude_input: '제외해야 할 입력자료',
  required_elements: '필수 포함 요소',
  required_issues: '문제점 (복수 선택)',
  first_action: '최초 조치',
  highest_risk: '가장 큰 리스크',
  immediate_action: '즉시 조치',
  example_prompt: '프롬프트 작성',
};
function l3Humanize(key: string): string {
  return L3_KEY_LABELS[key] ?? key.replace(/_/g, ' ');
}

/** Normalize a field key by stripping select_/check_/required_/must_ prefixes. */
function l3StripKey(key: string): string {
  let s = key.toLowerCase();
  while (/^(select|check|required|must)_/.test(s)) s = s.replace(/^(select|check|required|must)_/, '');
  return s.replace(/[_\s-]/g, '');
}

/** The responseFormat option pool (array) that corresponds to an answerKey field. */
function l3FindPool(responseFormat: Record<string, unknown>, key: string): string[] | null {
  const nk = l3StripKey(key);
  for (const [rk, rv] of Object.entries(responseFormat)) {
    if (Array.isArray(rv) && l3StripKey(rk) === nk) return rv.map((x) => String(x));
  }
  return null;
}

/** "80~150자" → {min:80,max:150}; "250자 이내" → {min:0,max:250}. */
function l3ParseLen(v: unknown, def: { min: number; max: number }): { min: number; max: number } {
  const s = typeof v === 'string' ? v : '';
  const range = s.match(/(\d+)\s*[~\-–]\s*(\d+)/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const upper = s.match(/(\d+)/);
  if (upper) return { min: 0, max: Number(upper[1]) };
  return def;
}

/** answerKey slots that are not selectable fields (prose / reference material). */
const L3_NON_FIELD_KEYS = new Set(['key_reason', 'example_prompt', 'example_revision_prompt']);

/**
 * v3 bank shape (new_version_v3):
 *   response_format:
 *     selection_fields: [{ name, select_count, options: { CODE: text } }]
 *     generation_field: { name, limit: '250자 이내' }
 *     short_reason: '80~150자'
 *
 * The render spec comes from `selection_fields` (labels, options, counts); the
 * answerKey supplies ONLY the field KEY each answer must serialize under — never
 * a value. They are paired BY INDEX: the bank guarantees positional equality
 * ("과제 지시 개수와 정답키 개수 일치"), and a name match is impossible
 * (key `first_verification` vs label `가장 먼저 할 검증 조치`).
 */
function l3ClientViewV3(
  r: Record<string, unknown>,
  answerKey: Record<string, unknown> | null,
  responseFormat: Record<string, unknown>,
): L3ClientView {
  const selectionFields = (responseFormat.selection_fields as unknown[]).filter(
    (f): f is Record<string, unknown> => asRecord(f) != null,
  );
  const keys = Object.keys(answerKey ?? {}).filter((k) => !L3_NON_FIELD_KEYS.has(k));

  const fields: L3Field[] = selectionFields.map((sf, i) => {
    const optionMap = asRecord(sf.options) ?? {};
    const choices: L3Option[] = Object.entries(optionMap).map(([code, text]) => ({
      code,
      text: String(text),
    }));
    const declared = Number(sf.select_count);
    return {
      // Fall back to a positional key only if the answerKey is short — the client
      // must still be able to submit something the grader can look up.
      key: keys[i] ?? `field_${i + 1}`,
      label: String(sf.name ?? `선택 ${i + 1}`),
      kind: 'select' as const,
      choices,
      selectCount: Number.isFinite(declared) && declared > 0 ? declared : 1,
    };
  });

  const gen = asRecord(responseFormat.generation_field);
  if (gen) {
    fields.push({
      // The grader reads the generated text from the envelope's TOP level
      // (PROMPT_KEYS in l3-practical-grader), never from `selects`.
      key: 'writePrompt',
      label: String(gen.name ?? '요청문 작성'),
      kind: 'generate',
      maxLen: l3ParseLen(gen.limit, { min: 0, max: 250 }).max,
    });
  }

  return {
    practiceType: typeof r.practiceType === 'string' ? r.practiceType : null,
    // v3 embeds the fixed AI output inside the scenario text, not a separate field.
    fixedAiOutput: typeof r.fixedAiOutput === 'string' ? r.fixedAiOutput : null,
    fields,
    reason: l3ParseLen(responseFormat.short_reason, { min: 80, max: 150 }),
  };
}

/**
 * Project the L3 실습형 rubric wrapper down to an answer-free render spec: one
 * field per answerKey slot (keyed by the answerKey field NAME so the client's
 * `selects` line up with the grader), option pools pulled from responseFormat.
 * The rubric's `answerKey` VALUES (correct answers), `key_reason`, and criterion
 * points are the grading ground truth and are deliberately never serialized.
 * Returns null for legacy L1/L2 rubrics or a task with no L3 wrapper.
 */
export function l3ClientView(rubric: unknown): L3ClientView | null {
  const r = asRecord(rubric);
  if (!r) return null;
  const answerKey = asRecord(r.answerKey);
  const responseFormat = asRecord(r.responseFormat) ?? {};
  if (!answerKey && !asRecord(r.responseFormat) && !('practiceType' in r)) return null;

  // v3 bank: the render spec lives in responseFormat.selection_fields.
  if (Array.isArray(responseFormat.selection_fields)) {
    return l3ClientViewV3(r, answerKey, responseFormat);
  }

  // ── Legacy (v2 bank / seed data): flat responseFormat pools keyed by field name.
  const fields: L3Field[] = [];
  for (const [k, v] of Object.entries(answerKey ?? {})) {
    if (k === 'key_reason') continue; // graded via the 근거(shortReason) field
    if (k === 'example_prompt') {
      fields.push({ key: k, label: l3Humanize(k), kind: 'prompt', maxLen: l3ParseLen(responseFormat.write_prompt, { min: 0, max: 250 }).max });
      continue;
    }
    const pool = l3FindPool(responseFormat, k);
    const isArray = Array.isArray(v);
    fields.push({
      key: k,
      label: l3Humanize(k),
      kind: isArray ? (pool ? 'multi' : 'multiText') : pool ? 'single' : 'text',
      ...(pool ? { options: pool } : {}),
    });
  }
  // Fallback: no answerKey (shouldn't happen for L3) — render responseFormat arrays.
  if (fields.length === 0) {
    for (const [k, v] of Object.entries(responseFormat)) {
      if (Array.isArray(v)) fields.push({ key: k, label: l3Humanize(k), kind: 'multi', options: v.map((x) => String(x)) });
    }
  }

  return {
    practiceType: typeof r.practiceType === 'string' ? r.practiceType : null,
    fixedAiOutput: typeof r.fixedAiOutput === 'string' ? r.fixedAiOutput : null,
    fields,
    reason: l3ParseLen(responseFormat.short_reason, { min: 80, max: 150 }),
  };
}

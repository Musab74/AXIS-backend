/**
 * In-exam AI scope guard.
 *
 * The candidate must not be able to lie to the in-exam assistant by pasting
 * another task's stem (typically a 서술형 essay where `aiToolAllowed = "AI 사용
 * 불가"`) into a practical task's AI chat. This module provides the
 * deterministic, language-agnostic similarity checks that gate every askAi()
 * turn BEFORE the prompt reaches Claude.
 *
 * Why trigrams (not LLM, not keyword): character trigram cosine works on
 * Korean without tokenization, runs in ~1ms per pair, and resists casual
 * paraphrase (a 200-char paste still scores > 0.5 even after light edits).
 *
 * Thresholds were picked conservatively to favour false-negatives over
 * false-positives — a wrongful rejection mid-exam is far costlier than a
 * missed paste (which the grader still sees later via aiChatLog).
 */

export interface SiblingTaskSnapshot {
  taskId: string;
  /** True when that sibling task allows AI (we never flag against same-policy siblings). */
  aiAllowed: boolean;
  /** The other task's stem material used for comparison. Concatenated title + scenario + requiredStructure. */
  scopeText: string;
}

export interface ScopeGuardConfig {
  /** Cross-task paste similarity that triggers HARD rejection. Default 0.55. */
  crossTaskRejectAt: number;
  /** Cross-task similarity (below reject) that still logs a SUSPICIOUS event. Default 0.40. */
  crossTaskFlagAt: number;
  /** Minimum prompt length (chars) for off-topic check; short prompts are always allowed. */
  offTopicMinLen: number;
  /** Maximum on-topic similarity below which a LONG prompt is rejected. Default 0.06. */
  offTopicMaxSim: number;
}

export const DEFAULT_SCOPE_GUARD_CONFIG: ScopeGuardConfig = {
  crossTaskRejectAt: 0.55,
  crossTaskFlagAt: 0.4,
  offTopicMinLen: 220,
  offTopicMaxSim: 0.06,
};

export type ScopeGuardVerdict =
  | { kind: 'ok' }
  | { kind: 'flag'; reason: 'cross_task_match_allowed_sibling'; matchedTaskId: string; sim: number }
  | { kind: 'reject'; reason: 'cross_task_paste_from_ai_forbidden'; matchedTaskId: string; sim: number }
  | { kind: 'reject'; reason: 'off_topic_paste'; onTopic: number };

/**
 * Normalize text for similarity scoring. We lowercase ASCII, drop punctuation
 * + whitespace, and keep Korean syllable blocks (Hangul, U+AC00–U+D7A3) and
 * latin/digit chars. Trigram cosine on this canonical form is paste-resistant
 * to minor whitespace tweaks ("ABC DEF" vs "ABC\nDEF") without being so
 * aggressive that legitimate edits trip it.
 */
export function normalize(input: string): string {
  if (!input) return '';
  let s = input.toLowerCase();
  // Keep: Hangul syllables/jamo, basic Latin letters, digits.
  // Drop: everything else (punct, whitespace, CJK punctuation, emojis…).
  s = s.replace(/[^a-z0-9\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/g, '');
  return s;
}

/** Character trigram multiset → frequency map. Empty string yields empty map. */
function trigramFreq(normalized: string): Map<string, number> {
  const m = new Map<string, number>();
  if (normalized.length < 3) {
    // Pad short strings so a 1-2 char prompt still gets a single trigram and
    // doesn't divide by zero downstream.
    const padded = normalized.padEnd(3, '_');
    m.set(padded, 1);
    return m;
  }
  for (let i = 0; i <= normalized.length - 3; i++) {
    const tri = normalized.slice(i, i + 3);
    m.set(tri, (m.get(tri) ?? 0) + 1);
  }
  return m;
}

/**
 * Cosine similarity over character trigram frequency vectors in [0, 1].
 * Returns 0 when either side is empty; returns 1 only on identical normalized
 * strings.
 */
export function trigramCosine(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  const fa = trigramFreq(na);
  const fb = trigramFreq(nb);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const [, v] of fa) magA += v * v;
  for (const [, v] of fb) magB += v * v;
  // Iterate the smaller map for the dot product.
  const [small, big] = fa.size <= fb.size ? [fa, fb] : [fb, fa];
  for (const [tri, v] of small) {
    const w = big.get(tri);
    if (w) dot += v * w;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Evaluate a candidate's askAi prompt against the current task's scope and
 * the session's sibling tasks. Returns the strongest verdict found.
 *
 *  - `reject` cross_task_paste_from_ai_forbidden: prompt strongly resembles a
 *    sibling task whose authored policy forbids AI. This is the "lie to AI to
 *    do my essay" attack — block hard, log AI_FLAG_SUSPICIOUS with details.
 *  - `reject` off_topic_paste: a long prompt that has near-zero overlap with
 *    the current task's scenario. Catches paste-from-elsewhere even when the
 *    "elsewhere" isn't a sibling task (e.g. external materials).
 *  - `flag`: medium similarity — let it through, but the caller should write a
 *    suspicious event so a human can review post-hoc.
 *  - `ok`: proceed to Claude.
 */
export function evaluatePromptScope(
  prompt: string,
  currentScopeText: string,
  siblings: SiblingTaskSnapshot[],
  cfg: ScopeGuardConfig = DEFAULT_SCOPE_GUARD_CONFIG,
): ScopeGuardVerdict {
  // 1) Cross-task contamination — strongest signal first. We score against
  //    every sibling and pick the highest match; AI-forbidden hits are rejects,
  //    AI-allowed hits are at worst a flag (a candidate quoting their own
  //    other practical task is annoying but not cheating).
  let topReject: { id: string; sim: number } | null = null;
  let topFlag: { id: string; sim: number } | null = null;
  for (const s of siblings) {
    const sim = trigramCosine(prompt, s.scopeText);
    if (!s.aiAllowed && sim >= cfg.crossTaskRejectAt) {
      if (!topReject || sim > topReject.sim) topReject = { id: s.taskId, sim };
    } else if (sim >= cfg.crossTaskFlagAt) {
      if (!topFlag || sim > topFlag.sim) topFlag = { id: s.taskId, sim };
    }
  }
  if (topReject) {
    return {
      kind: 'reject',
      reason: 'cross_task_paste_from_ai_forbidden',
      matchedTaskId: topReject.id,
      sim: round3(topReject.sim),
    };
  }

  // 2) Off-topic paste — only enforced on LONG prompts to avoid breaking
  //    legitimate one-line clarifying questions ("이 문장 다듬어줘") that
  //    naturally share little vocabulary with a long scenario.
  const promptNorm = normalize(prompt);
  if (promptNorm.length >= cfg.offTopicMinLen) {
    const onTopic = trigramCosine(prompt, currentScopeText);
    if (onTopic < cfg.offTopicMaxSim) {
      return { kind: 'reject', reason: 'off_topic_paste', onTopic: round3(onTopic) };
    }
  }

  if (topFlag) {
    return {
      kind: 'flag',
      reason: 'cross_task_match_allowed_sibling',
      matchedTaskId: topFlag.id,
      sim: round3(topFlag.sim),
    };
  }

  return { kind: 'ok' };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

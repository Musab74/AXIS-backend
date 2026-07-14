/**
 * Render a STRUCTURED candidate answer into readable Korean.
 *
 * The CBT stores structured answers as a JSON envelope in `EssayAnswer.contentText`
 * (the v3 CBT UI spec: "형식은 전부 UI가 제공한다 — 메모 행이 곧 데이터 행").
 * Two consumers must never see that raw JSON:
 *
 *   1. the Claude grader — it would receive opaque option CODES ("E1","V2") with
 *      no option text, and its rubric prompts are written to score narrative, so a
 *      key/value dump systematically deflates scores;
 *   2. human reviewers (expert/admin grading screens) — they must read the answer,
 *      not parse JSON.
 *
 * Plain-text answers pass through untouched, so legacy rows keep working.
 */
import { l3ClientView } from '../cbtExams/l3-client-view';

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Labels for the L2/L1 structured payloads, keyed by envelope `kind`. */
const SECTION_LABELS: Record<string, Record<string, string>> = {
  L2_A: {
    aiInstruction: 'AI 지시문',
    reportDraft: '최종 보고서 초안',
    revisionGrounds: '수정 근거',
    riskCheck: '리스크 체크',
  },
  L2_B: {
    summary: '핵심 요약',
    memos: '검증 메모',
    corrections: '수정 대상 목록',
  },
  L2_C: {
    steps: '업무흐름 단계',
    aiPlan: '단계별 AI 사용계획',
    riskCheck: '리스크 체크',
  },
  L1_B: { sections: '실행계획서' },
  L1_C: { elements: '서술 요소' },
};

/** One verification-memo / workflow-step row → a readable line. */
function renderRow(row: unknown, i: number): string {
  const r = rec(row);
  if (!r) return `  ${i + 1}. ${String(row ?? '').trim()}`;
  const parts = Object.entries(r)
    .filter(([, v]) => str(v) || typeof v === 'number')
    .map(([k, v]) => `${k}: ${String(v).trim()}`);
  return `  ${i + 1}. ${parts.join(' | ')}`;
}

function renderValue(label: string, value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    if (!value.length) return [];
    return [`[${label}]`, ...value.map(renderRow)];
  }
  const r = rec(value);
  if (r) {
    const inner = Object.entries(r)
      .filter(([, v]) => str(v) || (Array.isArray(v) && v.length))
      .map(([k, v]) => (Array.isArray(v) ? `  ${k}: ${v.join(', ')}` : `  ${k}: ${str(v)}`));
    return inner.length ? [`[${label}]`, ...inner] : [];
  }
  const s = str(value);
  return s ? [`[${label}]`, s] : [];
}

/**
 * @param rubric TaskTemplate.rubric — supplies the L3 option code → text map.
 * @param contentText the raw stored answer (JSON envelope, or plain prose).
 */
export function renderStructuredAnswer(rubric: unknown, contentText: string): string {
  const raw = (contentText ?? '').trim();
  if (!raw || !(raw.startsWith('{') || raw.startsWith('['))) return raw; // plain prose

  let env: Record<string, unknown> | null;
  try {
    env = rec(JSON.parse(raw));
  } catch {
    return raw;
  }
  if (!env) return raw;

  const out: string[] = [];

  // ── L3 실습형: resolve the selection CODES back to their option text ────────
  const selects = rec(env.selects);
  if (selects) {
    const view = l3ClientView(rubric);
    const fieldOf = (key: string) => view?.fields.find((f) => f.key === key);

    for (const [key, value] of Object.entries(selects)) {
      const field = fieldOf(key);
      const label = field?.label ?? key;
      const codes = Array.isArray(value) ? value.map(String) : [String(value)];
      const lines = codes.map((code) => {
        const opt = field?.choices?.find((c) => c.code === code);
        // Keep the code — the grader and the expert both reason in codes — but
        // always show the text so the answer is actually readable.
        return opt ? `  - ${code}: ${opt.text}` : `  - ${code}`;
      });
      out.push(`[${label}]`, ...lines);
    }
  }

  // ── the two free-text fields the grader reads from the TOP level ───────────
  const writePrompt = str(env.writePrompt) || str(env.write_prompt) || str(env.prompt);
  if (writePrompt) {
    const genLabel =
      l3ClientView(rubric)?.fields.find((f) => f.kind === 'generate')?.label ?? '요청문';
    out.push(`[${genLabel}]`, writePrompt);
  }
  const shortReason = str(env.shortReason) || str(env.short_reason) || str(env.rationale);
  if (shortReason) out.push('[판단 근거]', shortReason);

  // A free-text answer written before the structured UI shipped. The client
  // preserves it in the envelope rather than overwriting it, so it must still
  // reach the grader — otherwise a mid-exam deploy would silently zero someone.
  const legacy = str(env.legacyText);
  if (legacy) out.push('[이전 작성 답안]', legacy);

  // ── L2 / L1 structured payloads ───────────────────────────────────────────
  const kind = str(env.kind);
  if (kind) {
    const labels = SECTION_LABELS[kind] ?? {};
    for (const [key, value] of Object.entries(env)) {
      if (key === 'version' || key === 'kind' || key === 'legacyText') continue;
      if (key === 'selects' || key === 'shortReason' || key === 'writePrompt') continue;
      // L1 Part B nests its 10 sections; render each one under its own heading.
      const nested = key === 'sections' || key === 'elements' ? rec(value) : null;
      if (nested) {
        for (const [sk, sv] of Object.entries(nested)) out.push(...renderValue(sk, sv));
        continue;
      }
      out.push(...renderValue(labels[key] ?? key, value));
    }
  }

  // Nothing recognizable — fall back to the raw text rather than losing the answer.
  return out.length ? out.join('\n') : raw;
}

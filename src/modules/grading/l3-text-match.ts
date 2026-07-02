/**
 * Pure Korean text-matching helpers for L3 실습형 auto-grading.
 *
 * Reuses the exam prompt-scope guard's `normalize` (case-fold + strip
 * punctuation/whitespace, keep Hangul/Latin/digits) and `trigramCosine` so the
 * grader's fuzzy matching behaves consistently with the rest of the platform.
 */
import { normalize, trigramCosine } from '../cbtPractical/prompt-scope-guard';

/** trigram-cosine floor at which two short Korean phrases are treated as equal. */
const FUZZY_THRESHOLD = 0.6;

/** Count characters by code point so Hangul syllables count as 1 (not UTF-16 units). */
export function charLength(s: string): number {
  return Array.from(s ?? '').length;
}

/** Round to 2 decimals — partial credit yields fractional points. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Coerce an answer-key / candidate value into a trimmed string list. */
export function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  return [];
}

/** Whitespace/case/punctuation-insensitive equality with a trigram-similarity fallback. */
export function fuzzyEqual(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  return trigramCosine(a, b) >= FUZZY_THRESHOLD;
}

/**
 * F1 of a candidate multi-select vs the correct set (fuzzy per-item match).
 * Rewards recall (found the right items) and precision (didn't over-select).
 */
export function scoreSet(correct: string[], candidate: string[]): number {
  if (correct.length === 0) return candidate.length === 0 ? 1 : 0;
  const matchedCorrect = correct.filter((c) => candidate.some((x) => fuzzyEqual(c, x))).length;
  const matchedCand = candidate.filter((x) => correct.some((c) => fuzzyEqual(c, x))).length;
  const recall = matchedCorrect / correct.length;
  const precision = candidate.length ? matchedCand / candidate.length : 0;
  if (recall + precision === 0) return 0;
  return clamp01((2 * recall * precision) / (recall + precision));
}

/** Similarity of a single-choice answer in [0,1] (exact→1, else trigram cosine). */
export function scoreChoice(correct: string, candidate: string): number {
  if (!candidate.trim()) return 0;
  if (fuzzyEqual(correct, candidate)) return 1;
  return clamp01(trigramCosine(correct, candidate));
}

// Common Korean particles (josa) stripped off keyword tokens so "개인정보를"
// still matches "개인정보". Longer particles first so they win the endsWith test.
const JOSA = ['으로', '에서', '에게', '까지', '부터', '이나', '라도', '보다',
  '를', '을', '이', '가', '은', '는', '의', '에', '로', '와', '과', '도', '만', '나'];

function stripJosa(token: string): string {
  for (const j of JOSA) {
    if (token.length > j.length + 1 && token.endsWith(j)) return token.slice(0, -j.length);
  }
  return token;
}

const STOPWORDS = new Set(['그리고', '또한', '때문', '위해', '통해', '대한', '있는',
  '있다', '한다', '하는', '되는', '경우', '수', '등', '및', '것', '이는', '그']);

/** Content keywords from a reference sentence (answerKey.key_reason), de-duped. */
export function extractKeywords(text: string, limit = 8): string[] {
  const tokens = (text ?? '')
    .split(/[\s,.;:!?()[\]{}"'·…/\\]+/)
    .map((t) => stripJosa(t.trim()))
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const n = normalize(t);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/** Fraction of reference keywords present in the rationale (normalized substring), [0,1]. */
export function keywordCoverage(rationale: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const nr = normalize(rationale);
  if (!nr) return 0;
  const hit = keywords.filter((k) => {
    const nk = normalize(k);
    return nk.length >= 2 && nr.includes(nk);
  }).length;
  return hit / keywords.length;
}

const NEGATIONS = ['않', '없', '불필요', '아니', '문제없', '필요없', '해서는안', '하면안', '제외'];

/** True when a negation token sits near `term` inside `text` (contradiction heuristic). */
export function hasNegationNear(text: string, term: string, window = 12): boolean {
  const nt = normalize(text);
  const nk = normalize(term);
  if (!nt || !nk || !nt.includes(nk)) return false;
  for (let idx = nt.indexOf(nk); idx >= 0; idx = nt.indexOf(nk, idx + nk.length)) {
    const seg = nt.slice(Math.max(0, idx - window), idx + nk.length + window);
    if (NEGATIONS.some((neg) => seg.includes(normalize(neg)))) return true;
  }
  return false;
}

export interface SensitiveHit {
  code: string;
  kind: 'pii' | 'copyright';
}

const PII_PATTERNS: Array<{ code: string; re: RegExp }> = [
  { code: 'resident_number', re: /\d{6}[-\s]?\d{7}/ },
  { code: 'card_number', re: /\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}/ },
  { code: 'phone_number', re: /01\d[-\s]?\d{3,4}[-\s]?\d{4}/ },
  { code: 'email_address', re: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
];
const COPYRIGHT_RE = /(저작권|무단\s*전재|무단\s*복제|무단\s*배포|라이선스\s*위반|copyright|©)/i;

/** Detect PII / copyright-risk patterns in candidate free text. */
export function detectSensitivePatterns(text: string): SensitiveHit[] {
  const t = text ?? '';
  const hits: SensitiveHit[] = [];
  for (const p of PII_PATTERNS) {
    if (p.re.test(t)) hits.push({ code: p.code, kind: 'pii' });
  }
  if (COPYRIGHT_RE.test(t)) hits.push({ code: 'copyright_risk', kind: 'copyright' });
  return hits;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

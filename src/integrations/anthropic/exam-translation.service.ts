import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';

/**
 * QA/TEST-ONLY exam translation, gated STRICTLY on the ENGLISH_TEST_USER id.
 *
 * Purpose: let a single non-Korean tester take the real Korean exam — questions
 * are shown in English on the way out, and that user's free-text answers are
 * translated back to Korean before grading, so the Korean grader scores them
 * exactly as it would a native submission. Real candidates are never affected
 * (isEnglishTestUser returns false unless the id matches the env var).
 *
 * Uses Haiku (fastest model — translation is latency-critical: the candidate
 * is blocked on the paper request). Never throws — on any failure it returns
 * the original Korean, so the exam is never blocked. A content-hash cache
 * means identical strings (reloads, repeated options) are translated once
 * per process.
 */
const MODEL_ID = 'claude-haiku-4-5';
const TIMEOUT_MS = 45_000;
// Small batches fired IN PARALLEL: wall time ≈ one small call instead of the
// sum of large sequential ones, and a 10-string response can't overflow
// max_tokens (a 60-string batch could, silently degrading to Korean via the
// JSON-parse fallback).
const MAX_BATCH = 10;

export interface TranslatableUser {
  id: string;
  userId?: string | null;
}

@Injectable()
export class ExamTranslationService {
  private readonly logger = new Logger(ExamTranslationService.name);
  private readonly client: Anthropic | null;
  /** key: `${dir}:${sha1(text)}` → translated text. Process-lifetime cache. */
  private readonly cache = new Map<string, string>();

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ai.anthropicApiKey');
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    if (!apiKey) this.logger.warn('ANTHROPIC_API_KEY missing — ExamTranslationService disabled.');
  }

  /** True only for the configured single test id (matches DB id OR login userId). */
  isEnglishTestUser(user: TranslatableUser | null | undefined): boolean {
    const target = (process.env.ENGLISH_TEST_USER ?? '').trim();
    if (!target || !user) return false;
    return user.id === target || (user.userId ?? '') === target;
  }

  isEnabled(): boolean {
    return this.client !== null && !!(process.env.ENGLISH_TEST_USER ?? '').trim();
  }

  private ckey(dir: 'ko2en' | 'en2ko', text: string): string {
    return `${dir}:${createHash('sha1').update(text).digest('hex')}`;
  }

  /**
   * Korean → English for display. Returns an array the SAME length/order as the
   * input. Empty/blank strings pass through. Cached per string; only uncached
   * strings are sent, batched into one call each MAX_BATCH.
   */
  async toEnglish(texts: string[]): Promise<string[]> {
    if (!this.client || texts.length === 0) return texts;
    const out = [...texts];
    const pending: { idx: number; text: string }[] = [];
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (!t || !t.trim()) continue;
      const cached = this.cache.get(this.ckey('ko2en', t));
      if (cached != null) out[i] = cached;
      else pending.push({ idx: i, text: t });
    }
    const chunks: { idx: number; text: string }[][] = [];
    for (let i = 0; i < pending.length; i += MAX_BATCH) {
      chunks.push(pending.slice(i, i + MAX_BATCH));
    }
    // All chunks concurrently — translateBatch never throws (degrades to the
    // originals), so Promise.all cannot reject. Accept an output only if it
    // is actually English: the model occasionally echoes or paraphrases the
    // Korean back as perfectly valid JSON, which a parse check can't catch.
    // Rejected items are NOT cached (caching would pin the Korean original
    // as the "English" translation for the process lifetime) — they go to a
    // one-shot individual retry below.
    const hangulRatio = (s: string): number =>
      ((s.match(/[가-힣]/g) ?? []).length) / Math.max(1, s.length);
    const accept = (c: { idx: number; text: string }, tr: string | undefined): boolean => {
      // 0.2 tolerates legitimately embedded Korean (quoted phrases the
      // translation must preserve) while rejecting echoed/untranslated text.
      if (!tr || tr === c.text || hangulRatio(tr) > 0.2) return false;
      out[c.idx] = tr;
      this.cache.set(this.ckey('ko2en', c.text), tr);
      return true;
    };
    const failed = (
      await Promise.all(
        chunks.map(async (chunk) => {
          const translated = await this.translateBatch(chunk.map((c) => c.text), 'ko2en');
          return chunk.filter((c, j) => !accept(c, translated[j]));
        }),
      )
    ).flat();
    // One retry pass, item-by-item — a single-string JSON array is far harder
    // for the model to malform. Still-failing items stay Korean (never throw).
    if (failed.length > 0) {
      this.logger.warn(`retrying ${failed.length} untranslated string(s) individually`);
      await Promise.all(
        failed.map(async (c) => {
          const [tr] = await this.translateBatch([c.text], 'ko2en');
          accept(c, tr);
        }),
      );
    }
    return out;
  }

  /**
   * English → Korean for a single free-text answer, before grading. Optional
   * length window (L3 근거 = 80–150 Korean chars). Preserves numbers/facts.
   */
  async toKorean(text: string, opts?: { minChars?: number; maxChars?: number }): Promise<string> {
    if (!this.client || !text?.trim()) return text;
    const cached = this.cache.get(this.ckey('en2ko', text));
    if (cached != null) return cached;
    const lenRule =
      opts?.minChars && opts?.maxChars
        ? `\n번역문은 반드시 ${opts.minChars}~${opts.maxChars}자(한글 음절 1자 기준) 범위여야 합니다. ` +
          `${opts.minChars}자에 못 미치면 원문 취지를 유지한 채 자연스럽게 문장을 보강해 최소 ${opts.minChars}자 이상으로 맞추세요.`
        : '';
    const sys =
      '당신은 시험 답안 번역기입니다. 아래 영어 답안을 자연스러운 한국어로 번역하세요. ' +
      '수치·고유명사·구체 사실을 반드시 보존하고, 내용을 추가하거나 생략하지 마세요. ' +
      '번역문만 출력하세요(설명·따옴표 없이).' +
      lenRule;
    const result = await this.call(sys, text);
    // Cache only real translations — caching the fallback would pin the
    // untranslated English for the process lifetime.
    if (result) this.cache.set(this.ckey('en2ko', text), result);
    return result ?? text;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async translateBatch(items: string[], dir: 'ko2en' | 'en2ko'): Promise<string[]> {
    const [from, to] = dir === 'ko2en' ? ['Korean', 'English'] : ['English', 'Korean'];
    const sys =
      `Translate each item from ${from} to natural ${to}. Preserve every number, ` +
      `proper noun, and line break. Do NOT add or omit content. Respond with ONLY a ` +
      `JSON array of strings, same length and order as the input — no other text.`;
    const user = JSON.stringify(items);
    const raw = await this.call(sys, user);
    if (!raw) return items;
    try {
      const start = raw.indexOf('[');
      const end = raw.lastIndexOf(']');
      const arr = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
      if (Array.isArray(arr) && arr.length === items.length) {
        return arr.map((v, i) => (typeof v === 'string' && v.trim() ? v : items[i]));
      }
    } catch {
      /* fall through to originals */
    }
    return items;
  }

  private async call(system: string, user: string): Promise<string | null> {
    if (!this.client) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await this.client.messages.create(
        {
          model: MODEL_ID,
          max_tokens: 4096,
          system,
          messages: [{ role: 'user', content: user }],
        },
        { signal: ac.signal },
      );
      const block = res.content.find((b) => b.type === 'text');
      return block && block.type === 'text' ? block.text.trim() : null;
    } catch (err) {
      this.logger.warn(`translation failed: ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

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
 * Uses Sonnet (same model as the in-exam assistant). Never throws — on any
 * failure it returns the original Korean, so the exam is never blocked. A
 * content-hash cache means identical strings (reloads, repeated options) are
 * translated once per process.
 */
const MODEL_ID = 'claude-sonnet-4-6';
const TIMEOUT_MS = 45_000;
const MAX_BATCH = 60; // strings per call

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
    for (let i = 0; i < pending.length; i += MAX_BATCH) {
      const chunk = pending.slice(i, i + MAX_BATCH);
      const translated = await this.translateBatch(chunk.map((c) => c.text), 'ko2en');
      chunk.forEach((c, j) => {
        const tr = translated[j];
        if (tr) {
          out[c.idx] = tr;
          this.cache.set(this.ckey('ko2en', c.text), tr);
        }
      });
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
    const ko = result ?? text;
    this.cache.set(this.ckey('en2ko', text), ko);
    return ko;
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

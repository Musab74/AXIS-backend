import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GoogleGenerativeAI,
  type GenerativeModel,
  SchemaType,
} from '@google/generative-ai';
import sharp from 'sharp';

export const GEMINI_FLAG_VALUES = [
  'PHONE_IN_FRAME',
  'OTHER_DEVICE_IN_FRAME',
  'HEADPHONES_OR_EARBUDS',
  'SMART_GLASSES',
  'EARPIECE',
  'HAT_OR_HOOD',
  'MASK_COVERING_FACE',
  'SECOND_PERSON_IN_FRAME',
  'LOOKING_OFF_SCREEN',
  'HANDS_NEAR_EARS',
  'PAPER_OR_BOOK',
  'WRITING_ON_HAND',
  'OTHER_SUSPICIOUS',
] as const;

export type GeminiFlag = (typeof GEMINI_FLAG_VALUES)[number];

export interface GeminiScreenContext {
  sessionId: string;
  userId: string;
  certType: string;
  level: string;
  /** Client epoch ms — passed through for log correlation only. */
  ts: number;
}

export interface GeminiScreenResult {
  suspicious: boolean;
  confidence: number;
  flags: GeminiFlag[];
  notes: string;
  modelMs: number;
  inputTokens: number;
  outputTokens: number;
  /** True when the integration was unavailable or threw — caller should degrade. */
  degraded: boolean;
}

const SYSTEM_PROMPT = `You are a silent screening pass for an online exam proctoring system. You see one webcam frame of an exam-taker at their desk. Your only job is to flag potentially-prohibited objects, behaviors, or people in the frame.

Return JSON conforming to the provided schema. Be conservative: if you are not at least 50% sure something is present, do not include it. Do not narrate. Do not greet. Do not explain. The "notes" field is at most one short sentence used only for engineering logs.

Prohibited at all times: phones, tablets, laptops other than the exam machine, second monitors visible to the camera, headphones, earbuds, in-ear earpieces, smart glasses, AR/VR devices, hats covering the eyes, hoods, face-covering masks, a second person in the frame, papers or books, writing on hands or arms.

Allowed: prescription eyeglasses, the exam-taker's own face, the exam machine itself, hands on keyboard, ordinary room background.

If the frame is too dark, blurry, or empty to evaluate, return suspicious=false and notes="unrenderable".`;

const MODEL_ID = 'gemini-2.5-flash-lite';
const TIMEOUT_MS = 4_000;
// Frame size sent to Gemini. Bumped from 160×120 → 480×360 (proctor
// detection-gap-fix Step 4) because a phone in the lap or held below the
// chest occupies only ~20-30 px at 160×120 and Gemini routinely missed it.
// Per-image token cost goes from ~258 (default tile) to roughly 4× — still
// well under $0.001 per call at gemini-2.5-flash-lite list pricing. Keep
// JPEG quality at 70: the lossy artefacts at 70 are below Gemini's effective
// resolution at this size.
const SCREEN_WIDTH = 480;
const SCREEN_HEIGHT = 360;

@Injectable()
export class GeminiVisionService {
  private readonly logger = new Logger(GeminiVisionService.name);
  private readonly model: GenerativeModel | null;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ai.geminiApiKey');
    if (!apiKey) {
      this.logger.warn('GOOGLE_GEMINI_API_KEY missing — GeminiVisionService is offline.');
      this.model = null;
      return;
    }
    const genai = new GoogleGenerativeAI(apiKey);
    this.model = genai.getGenerativeModel({
      model: MODEL_ID,
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            suspicious: { type: SchemaType.BOOLEAN },
            confidence: { type: SchemaType.NUMBER },
            flags: {
              type: SchemaType.ARRAY,
              items: {
                type: SchemaType.STRING,
                enum: [...GEMINI_FLAG_VALUES],
              },
            },
            notes: { type: SchemaType.STRING },
          },
          required: ['suspicious', 'confidence', 'flags', 'notes'],
        },
      },
    });
  }

  isConfigured(): boolean {
    return this.model !== null;
  }

  async screen(
    frame: Buffer,
    ctx: GeminiScreenContext,
  ): Promise<GeminiScreenResult> {
    const t0 = Date.now();
    const offline: GeminiScreenResult = {
      suspicious: false,
      confidence: 0,
      flags: [],
      notes: 'offline',
      modelMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      degraded: true,
    };
    if (!this.model) return offline;

    let downscaled: Buffer;
    try {
      downscaled = await sharp(frame)
        .resize(SCREEN_WIDTH, SCREEN_HEIGHT, { fit: 'cover' })
        .jpeg({ quality: 70 })
        .toBuffer();
    } catch (err) {
      this.logger.warn(`downscale failed: ${(err as Error).message}`);
      return { ...offline, notes: 'downscale-failed' };
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

    try {
      const res = await this.model.generateContent(
        {
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType: 'image/jpeg',
                    data: downscaled.toString('base64'),
                  },
                },
                {
                  text: `ctx: session=${ctx.sessionId} cert=${ctx.certType}/${ctx.level} ts=${ctx.ts}`,
                },
              ],
            },
          ],
        },
        { signal: ac.signal },
      );
      clearTimeout(timer);

      const text = res.response.text();
      const usage = res.response.usageMetadata;
      const parsed = this.parse(text);

      return {
        suspicious: parsed.suspicious,
        confidence: clamp01(parsed.confidence),
        flags: parsed.flags,
        notes: parsed.notes,
        modelMs: Date.now() - t0,
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
        degraded: false,
      };
    } catch (err) {
      clearTimeout(timer);
      const msg = (err as Error).message;
      this.logger.warn(`Gemini screen failed (session=${ctx.sessionId}): ${msg}`);
      // Sentry breadcrumb hook: when @sentry/node lands, replace with
      // Sentry.addBreadcrumb({ category: 'proctor.ai.gemini', level: 'warning', message: msg })
      return { ...offline, notes: `error:${msg.slice(0, 60)}`, modelMs: Date.now() - t0 };
    }
  }

  private parse(text: string): {
    suspicious: boolean;
    confidence: number;
    flags: GeminiFlag[];
    notes: string;
  } {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { suspicious: false, confidence: 0, flags: [], notes: 'parse-error' };
    }
    if (!raw || typeof raw !== 'object') {
      return { suspicious: false, confidence: 0, flags: [], notes: 'parse-shape' };
    }
    const obj = raw as Record<string, unknown>;
    const suspicious = obj.suspicious === true;
    const confidence = typeof obj.confidence === 'number' ? obj.confidence : 0;
    const flagsRaw = Array.isArray(obj.flags) ? obj.flags : [];
    const flags: GeminiFlag[] = [];
    for (const f of flagsRaw) {
      if (typeof f === 'string' && (GEMINI_FLAG_VALUES as readonly string[]).includes(f)) {
        flags.push(f as GeminiFlag);
      }
    }
    const notes =
      typeof obj.notes === 'string' ? obj.notes.slice(0, 200) : '';
    return { suspicious, confidence, flags, notes };
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import type { GeminiScreenResult } from '../googleGemini/google-gemini.service';

export type ClaudeSeverity = 'LOW' | 'MED' | 'HIGH';

export interface ClaudeProctorContext {
  sessionId: string;
  userId: string;
  certType: string;
  level: string;
  ts: number;
}

export interface ClaudeProctorResult {
  confirmed: boolean;
  severity: ClaudeSeverity;
  ruleBroken: string;
  captionKo: string;
  captionEn: string;
  modelMs: number;
  /** True when Claude was unavailable or threw — caller should degrade. */
  degraded: boolean;
}

const MODEL_ID = 'claude-sonnet-4-6';
const TIMEOUT_MS = 6_000;
const MAX_TOKENS = 400;

const SYSTEM_PROMPT = `You are the verification stage of a tiered AI proctor for a Korean professional certification exam (AXIS / AXIS-C / AXIS-H). A faster screening model has flagged a webcam frame as potentially showing a rule break. You must independently verify, then either confirm or dismiss.

You will be given: (1) the webcam frame, (2) the screening model's flags. Treat the screening flags as a hint, not a verdict — you may dismiss them or find different rules broken.

Rules in this exam:
- No phones, tablets, second monitors, laptops other than the exam machine.
- No headphones, earbuds, in-ear earpieces, smart glasses, AR/VR devices.
- No hats covering the eyes, no hoods, no masks covering the face.
- No second person visible in the frame.
- No papers, books, notes, writing on hands or arms.
- The exam-taker must be looking at the screen most of the time. Brief glances away are normal.

Severity:
- LOW   = clear evidence of a minor rule break that warrants a logged warning but not termination (e.g. brief phone glance, hat on, hand near ear once).
- MED   = sustained or clear unauthorized object/behavior (phone visibly in use, headphones on, looking off-screen for an extended moment).
- HIGH  = clear cheating in progress (second person visible, reading from external notes, earpiece confirmed, two devices in use).

Output via the \`submit_verification\` tool. Captions must be a single short sentence each, factual and dispassionate, suitable to show both the admin and the student during a dispute. Do NOT speculate beyond what is visible. If you cannot confirm, return confirmed=false.

Korean caption style: 존댓말, 사실 위주. Example: "휴대전화가 책상 위에 보입니다."
English caption style: factual present-tense. Example: "A mobile phone is visible on the desk."`;

const VERIFICATION_TOOL = {
  name: 'submit_verification',
  description: 'Submit the final verification verdict for the flagged frame.',
  input_schema: {
    type: 'object' as const,
    required: ['confirmed', 'severity', 'ruleBroken', 'captionKo', 'captionEn'] as string[],
    properties: {
      confirmed: { type: 'boolean' as const },
      severity: { type: 'string' as const, enum: ['LOW', 'MED', 'HIGH'] },
      ruleBroken: { type: 'string' as const, maxLength: 64 },
      captionKo: { type: 'string' as const, maxLength: 120 },
      captionEn: { type: 'string' as const, maxLength: 120 },
    },
  },
};

@Injectable()
export class ClaudeProctorService {
  private readonly logger = new Logger(ClaudeProctorService.name);
  private readonly client: Anthropic | null;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ai.anthropicApiKey');
    if (!apiKey) {
      this.logger.warn('ANTHROPIC_API_KEY missing — ClaudeProctorService is offline.');
      this.client = null;
      return;
    }
    this.client = new Anthropic({ apiKey });
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  /**
   * Verify a flagged frame and emit bilingual captions. The system prompt and
   * tool schema are marked as cache breakpoints so the second-and-later calls
   * within the 5-min Anthropic cache window pay the cached input rate.
   *
   * The full 320×240 frame is sent (caller passes original buffer, not the
   * 160×120 downscale that goes to Gemini).
   */
  async verifyAndCaption(
    frame: Buffer,
    geminiResult: GeminiScreenResult,
    ctx: ClaudeProctorContext,
  ): Promise<ClaudeProctorResult> {
    const t0 = Date.now();
    const offline: ClaudeProctorResult = {
      confirmed: false,
      severity: 'LOW',
      ruleBroken: '',
      captionKo: '',
      captionEn: '',
      modelMs: 0,
      degraded: true,
    };
    if (!this.client) return offline;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

    try {
      const res = await this.client.beta.messages.create(
        {
          model: MODEL_ID,
          max_tokens: MAX_TOKENS,
          system: [
            {
              type: 'text',
              text: SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' },
            },
          ],
          tools: [
            {
              ...VERIFICATION_TOOL,
              cache_control: { type: 'ephemeral' },
            },
          ],
          tool_choice: { type: 'tool', name: 'submit_verification' },
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/jpeg',
                    data: frame.toString('base64'),
                  },
                },
                {
                  type: 'text',
                  text:
                    `Tier-1 screening flags: ${
                      geminiResult.flags.length ? geminiResult.flags.join(', ') : '(none)'
                    }\n` +
                    `Tier-1 confidence: ${geminiResult.confidence.toFixed(2)}\n` +
                    `Tier-1 notes: ${geminiResult.notes || '(none)'}\n` +
                    `Session: ${ctx.sessionId} (${ctx.certType}/${ctx.level})`,
                },
              ],
            },
          ],
        },
        { signal: ac.signal },
      );
      clearTimeout(timer);

      const verdict = this.extractToolUse(res.content);
      if (!verdict) {
        this.logger.warn(`Claude returned no tool_use (session=${ctx.sessionId})`);
        return { ...offline, modelMs: Date.now() - t0 };
      }

      return {
        confirmed: verdict.confirmed,
        severity: verdict.severity,
        ruleBroken: verdict.ruleBroken.slice(0, 64),
        captionKo: verdict.captionKo.slice(0, 120),
        captionEn: verdict.captionEn.slice(0, 120),
        modelMs: Date.now() - t0,
        degraded: false,
      };
    } catch (err) {
      clearTimeout(timer);
      const msg = (err as Error).message;
      this.logger.warn(`Claude verify failed (session=${ctx.sessionId}): ${msg}`);
      return { ...offline, modelMs: Date.now() - t0 };
    }
  }

  private extractToolUse(content: Anthropic.Beta.Messages.BetaContentBlock[]): {
    confirmed: boolean;
    severity: ClaudeSeverity;
    ruleBroken: string;
    captionKo: string;
    captionEn: string;
  } | null {
    const block = content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use' || block.name !== 'submit_verification') {
      return null;
    }
    const input = block.input as Record<string, unknown>;
    const sev = input.severity;
    if (sev !== 'LOW' && sev !== 'MED' && sev !== 'HIGH') return null;
    const captionKo = typeof input.captionKo === 'string' ? input.captionKo : '';
    const captionEn = typeof input.captionEn === 'string' ? input.captionEn : '';
    if (!captionKo || !captionEn) return null;
    return {
      confirmed: input.confirmed === true,
      severity: sev,
      ruleBroken: typeof input.ruleBroken === 'string' ? input.ruleBroken : '',
      captionKo,
      captionEn,
    };
  }
}

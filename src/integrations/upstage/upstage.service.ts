import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type KoreanIdType = 'RESIDENT_REGISTRATION' | 'DRIVER_LICENSE' | 'PASSPORT' | 'UNKNOWN';

export interface KoreanIdCardData {
  idType: KoreanIdType;
  name: string | null;
  birthDate: string | null;     // YYYY-MM-DD
  rrnFront: string | null;      // 6 digits (e.g. "900101") — back is masked
  rrnBackFirstDigit: string | null; // single digit, region/century indicator
  rrnMasked: string | null;     // e.g. "900101-1******"
  issueDate: string | null;     // YYYY-MM-DD
  issuingAuthority: string | null;
  licenseNumber: string | null; // driver's license only
  passportNumber: string | null; // passport only
  rawConfidence: number;        // 0..1, model self-reported
}

const SYSTEM_PROMPT = `You are an OCR extraction assistant for Korean government-issued ID cards.
You receive an image of one of: 주민등록증 (Resident Registration Card), 운전면허증 (Driver's License), or 여권 (Passport).
Extract the printed fields and return STRICT JSON matching the provided schema. No prose, no markdown.

Rules:
- Field "idType": "RESIDENT_REGISTRATION" | "DRIVER_LICENSE" | "PASSPORT" | "UNKNOWN"
- Field "name": full Korean name as printed (성+이름), no spaces, e.g. "홍길동". If a romanized name is also present, ignore it.
- Field "birthDate": YYYY-MM-DD. If only the RRN front 6 digits are visible (YYMMDD), infer the century from the back's first digit (1,2,5,6 → 1900s; 3,4,7,8 → 2000s) and return YYYY-MM-DD.
- Field "rrnFront": exactly 6 digits, no dash. null if not visible.
- Field "rrnBackFirstDigit": exactly 1 digit. null if not visible.
- Field "issueDate" / "issuingAuthority": parse the date the card was issued and the authority name as printed, or null.
- Field "licenseNumber": driver's license number with dashes as printed, or null.
- Field "passportNumber": passport machine-readable number, or null.
- Field "rawConfidence": your own confidence 0..1 that the extraction is correct.
- If a field is not visible or not on this card type, use null. NEVER guess.
- Return JSON only. Do not include "rrnMasked" — the server computes it.`;

const USER_PROMPT = `Extract the ID card fields. Return JSON only matching the schema.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    idType: { type: 'string', enum: ['RESIDENT_REGISTRATION', 'DRIVER_LICENSE', 'PASSPORT', 'UNKNOWN'] },
    name: { type: ['string', 'null'] },
    birthDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    rrnFront: { type: ['string', 'null'], pattern: '^\\d{6}$' },
    rrnBackFirstDigit: { type: ['string', 'null'], pattern: '^\\d$' },
    issueDate: { type: ['string', 'null'] },
    issuingAuthority: { type: ['string', 'null'] },
    licenseNumber: { type: ['string', 'null'] },
    passportNumber: { type: ['string', 'null'] },
    rawConfidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: [
    'idType', 'name', 'birthDate', 'rrnFront', 'rrnBackFirstDigit',
    'issueDate', 'issuingAuthority', 'licenseNumber', 'passportNumber', 'rawConfidence',
  ],
} as const;

@Injectable()
export class UpstageService {
  private readonly logger = new Logger(UpstageService.name);
  private readonly endpoint = 'https://api.upstage.ai/v1/chat/completions';
  private readonly model = 'solar-pro2';

  constructor(private readonly config: ConfigService) {}

  async extractIdCard(image: Buffer, mimeType: string): Promise<KoreanIdCardData> {
    const apiKey = this.config.get<string>('upstage.apiKey');
    if (!apiKey) {
      throw new ServiceUnavailableException('Upstage API key not configured');
    }

    const dataUrl = `data:${mimeType};base64,${image.toString('base64')}`;

    const body = {
      model: this.model,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'korean_id_card', strict: true, schema: SCHEMA },
      },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: USER_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 800,
      temperature: 0,
    };

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      this.logger.error(`Upstage API ${res.status}: ${errText.slice(0, 300)}`);
      throw new BadGatewayException(`Upstage extraction failed (HTTP ${res.status})`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new BadGatewayException('Upstage returned empty response');
    }

    let parsed: Omit<KoreanIdCardData, 'rrnMasked'>;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new BadGatewayException('Upstage returned non-JSON content');
    }

    const rrnMasked =
      parsed.rrnFront && parsed.rrnBackFirstDigit
        ? `${parsed.rrnFront}-${parsed.rrnBackFirstDigit}******`
        : null;

    this.logger.log(
      `ID extraction: type=${parsed.idType} name_len=${parsed.name?.length ?? 0} ` +
        `dob=${parsed.birthDate ?? 'null'} rrn=${rrnMasked ?? 'null'} ` +
        `confidence=${parsed.rawConfidence}`,
    );

    return { ...parsed, rrnMasked };
  }
}

import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { parseIdFields } from './clova-id-parser';

export type KoreanIdType =
  | 'RESIDENT_REGISTRATION'
  | 'FOREIGN_RESIDENT_CARD'
  | 'DRIVER_LICENSE'
  | 'PASSPORT'
  | 'UNKNOWN';

export interface KoreanIdCardData {
  idType: KoreanIdType;
  name: string | null;
  birthDate: string | null;       // YYYY-MM-DD
  rrnFront: string | null;        // 6 digits (YYMMDD)
  rrnBackFirstDigit: string | null;
  rrnMasked: string | null;       // e.g. "030224-7******"
  issueDate: string | null;
  issuingAuthority: string | null;
  licenseNumber: string | null;
  passportNumber: string | null;
  rawConfidence: number;          // average inferConfidence across fields, 0..1
}

interface ClovaField {
  name?: string;
  inferText: string;
  inferConfidence: number;
  valueType?: string;
}

interface ClovaImage {
  inferResult: 'SUCCESS' | 'FAILURE' | 'ERROR';
  message: string;
  fields?: ClovaField[];
}

interface ClovaResponse {
  version: string;
  requestId: string;
  timestamp: number;
  images: ClovaImage[];
}

@Injectable()
export class ClovaOcrService {
  private readonly logger = new Logger(ClovaOcrService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Calls Naver CLOVA OCR (general/custom endpoint configured in env) and parses
   * the returned text fields into a Korean-ID-shaped result.
   *
   * Supports both Korean Resident Card (주민등록증) and Foreign Resident Card
   * (외국인등록증). The latter has Latin names and a back-digit of 5/6/7/8.
   */
  async extractIdCard(image: Buffer, mimeType: string): Promise<KoreanIdCardData> {
    const invokeUrl = this.config.get<string>('clovaOcr.invokeUrl');
    const secret = this.config.get<string>('clovaOcr.secret');
    if (!invokeUrl || !secret) {
      throw new ServiceUnavailableException('CLOVA OCR not configured');
    }

    const fields = await this.callClova(invokeUrl, secret, image, mimeType);
    const parsed = parseIdFields(fields);

    const rrnMasked =
      parsed.rrnFront && parsed.rrnBackFirstDigit
        ? `${parsed.rrnFront}-${parsed.rrnBackFirstDigit}******`
        : null;

    this.logger.log(
      `CLOVA extraction: type=${parsed.idType} name_len=${parsed.name?.length ?? 0} ` +
        `dob=${parsed.birthDate ?? 'null'} rrn=${rrnMasked ?? 'null'} ` +
        `confidence=${parsed.rawConfidence.toFixed(2)} fields=${fields.length}`,
    );

    return { ...parsed, rrnMasked };
  }

  // ── transport ────────────────────────────────────────────────────

  private async callClova(
    invokeUrl: string,
    secret: string,
    image: Buffer,
    mimeType: string,
  ): Promise<ClovaField[]> {
    const format = this.formatFromMime(mimeType);
    const message = JSON.stringify({
      version: 'V2',
      requestId: randomUUID(),
      timestamp: Date.now(),
      lang: 'ko',
      images: [{ format, name: 'idCard' }],
    });

    const fd = new FormData();
    fd.append('message', message);
    fd.append(
      'file',
      new Blob([new Uint8Array(image)], { type: mimeType }),
      `id.${format}`,
    );

    let res: Response;
    try {
      res = await fetch(invokeUrl, {
        method: 'POST',
        headers: { 'X-OCR-SECRET': secret },
        body: fd,
      });
    } catch (err) {
      this.logger.error(`CLOVA OCR network error: ${(err as Error).message}`);
      throw new BadGatewayException('CLOVA OCR network error');
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      this.logger.error(`CLOVA OCR ${res.status}: ${errText.slice(0, 300)}`);
      throw new BadGatewayException(`CLOVA OCR failed (HTTP ${res.status})`);
    }

    let json: ClovaResponse;
    try {
      json = (await res.json()) as ClovaResponse;
    } catch {
      throw new BadGatewayException('CLOVA OCR returned non-JSON');
    }

    const image0 = json.images?.[0];
    if (!image0 || image0.inferResult !== 'SUCCESS') {
      this.logger.warn(
        `CLOVA inferResult=${image0?.inferResult ?? 'NONE'} msg=${image0?.message}`,
      );
      throw new BadGatewayException(
        `CLOVA OCR could not read the image: ${image0?.message ?? 'unknown'}`,
      );
    }

    return image0.fields ?? [];
  }

  private formatFromMime(mime: string): 'jpg' | 'png' | 'pdf' | 'tiff' {
    const m = mime.toLowerCase();
    if (m.includes('png')) return 'png';
    if (m.includes('pdf')) return 'pdf';
    if (m.includes('tif')) return 'tiff';
    return 'jpg';
  }
}

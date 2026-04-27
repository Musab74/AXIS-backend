import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { UpstageService, KoreanIdCardData } from '../../integrations/upstage/upstage.service';
import {
  AwsRekognitionService,
  FaceCompareResult,
} from '../../integrations/awsRekognition/aws-rekognition.service';

export type IdentityVerdict = 'PASS' | 'REVIEW' | 'FAIL';

export interface FieldMatch {
  expected: string | null;
  actual: string | null;
  matched: boolean;
}

export interface IdentityVerificationResult {
  verdict: IdentityVerdict;
  reasons: string[];
  idCard: KoreanIdCardData;
  nameMatch: FieldMatch;
  birthDateMatch: FieldMatch | null;
  faceMatch: FaceCompareResult;
}

interface VerifyInput {
  idImage: Buffer;
  idImageMime: string;
  liveFaceImage: Buffer;
  expectedName: string;
  expectedBirthDate?: string;
}

const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const MAX_BYTES = 8 * 1024 * 1024;

@Injectable()
export class IdentityVerificationService {
  private readonly logger = new Logger(IdentityVerificationService.name);

  constructor(
    private readonly upstage: UpstageService,
    private readonly rekognition: AwsRekognitionService,
  ) {}

  async verify(input: VerifyInput): Promise<IdentityVerificationResult> {
    this.assertImage(input.idImage, input.idImageMime, 'ID card');
    this.assertImage(input.liveFaceImage, 'image/jpeg', 'live face');

    const idCard = await this.upstage.extractIdCard(input.idImage, input.idImageMime);

    const nameMatch = this.matchName(input.expectedName, idCard.name);
    const birthDateMatch = input.expectedBirthDate
      ? this.matchBirthDate(input.expectedBirthDate, idCard.birthDate)
      : null;

    const faceMatch = await this.rekognition.compareFaces(input.idImage, input.liveFaceImage);

    const reasons: string[] = [];
    if (!nameMatch.matched) reasons.push('NAME_MISMATCH');
    if (birthDateMatch && !birthDateMatch.matched) reasons.push('BIRTHDATE_MISMATCH');
    if (faceMatch.decision === 'NO_MATCH') reasons.push('FACE_NO_MATCH');
    if (faceMatch.decision === 'REVIEW') reasons.push('FACE_REVIEW');
    if (faceMatch.targetFaceCount > 1) reasons.push('MULTIPLE_FACES_IN_FRAME');
    if (idCard.idType === 'UNKNOWN') reasons.push('ID_TYPE_UNKNOWN');
    if (idCard.rawConfidence < 0.6) reasons.push('LOW_OCR_CONFIDENCE');

    const verdict = this.decide(nameMatch, birthDateMatch, faceMatch, idCard);

    this.logger.log(
      `Identity verdict=${verdict} reasons=[${reasons.join(',')}] ` +
        `name_ok=${nameMatch.matched} face=${faceMatch.decision} ` +
        `face_sim=${faceMatch.similarity.toFixed(2)}`,
    );

    return { verdict, reasons, idCard, nameMatch, birthDateMatch, faceMatch };
  }

  private decide(
    nameMatch: FieldMatch,
    birthDateMatch: FieldMatch | null,
    faceMatch: FaceCompareResult,
    idCard: KoreanIdCardData,
  ): IdentityVerdict {
    const fieldsOk = nameMatch.matched && (birthDateMatch?.matched ?? true);

    if (faceMatch.decision === 'NO_MATCH') return 'FAIL';
    if (!nameMatch.matched) return 'FAIL';
    if (birthDateMatch && !birthDateMatch.matched) return 'FAIL';

    if (faceMatch.decision === 'REVIEW') return 'REVIEW';
    if (faceMatch.targetFaceCount > 1) return 'REVIEW';
    if (idCard.idType === 'UNKNOWN') return 'REVIEW';
    if (idCard.rawConfidence < 0.6) return 'REVIEW';

    return fieldsOk ? 'PASS' : 'REVIEW';
  }

  private matchName(expected: string, actual: string | null): FieldMatch {
    const a = this.normalizeKoreanName(expected);
    const b = actual ? this.normalizeKoreanName(actual) : null;
    return { expected, actual, matched: !!b && a === b };
  }

  private matchBirthDate(expected: string, actual: string | null): FieldMatch {
    return { expected, actual, matched: actual !== null && expected === actual };
  }

  private normalizeKoreanName(name: string): string {
    return name.replace(/\s+/g, '').trim();
  }

  private assertImage(buf: Buffer, mime: string, label: string): void {
    if (!buf || buf.length === 0) {
      throw new BadRequestException(`${label} image is required`);
    }
    if (buf.length > MAX_BYTES) {
      throw new BadRequestException(`${label} image exceeds 8MB`);
    }
    if (!ALLOWED_MIME.has(mime.toLowerCase())) {
      throw new BadRequestException(`${label} must be jpeg, png, or webp`);
    }
  }
}

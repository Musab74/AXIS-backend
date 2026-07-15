import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClovaOcrService, KoreanIdCardData } from '../../integrations/clovaOcr/clova-ocr.service';
import {
  AwsRekognitionService,
  FaceCompareResult,
  FaceMatchDecision,
} from '../../integrations/awsRekognition/aws-rekognition.service';
import { PrismaService } from '../../common/prisma.service';
import { FaceReferenceService } from '../proctor/face-reference.service';

export type IdentityVerdict = 'PASS' | 'REVIEW' | 'FAIL';

export interface FieldMatch {
  expected: string | null;
  actual: string | null;
  matched: boolean;
}

export interface FaceMatchSummary {
  decision: FaceMatchDecision | 'SKIPPED';
  similarity: number;
  sourceFaceCount: number;
  targetFaceCount: number;
  matched: boolean;
  skippedReason?: string;
}

/**
 * Pre-exam identity verification result.
 *
 * The pre-exam step combines CLOVA OCR (extract name + DOB from the ID card)
 * with AWS Rekognition CompareFaces (the photo on the ID vs the live selfie).
 * Both must succeed to PASS. AWS Rekognition is also used during the exam for
 * presence + gaze monitoring (see /cbt/proctor/face-check).
 */
export interface IdentityVerificationResult {
  verdict: IdentityVerdict;
  reasons: string[];
  idCard: KoreanIdCardData;
  nameMatch: FieldMatch;
  birthDateMatch: FieldMatch | null;
  faceMatch: FaceMatchSummary;
  liveness: {
    selfieReceived: boolean;
    selfieByteSize: number;
  };
}

interface VerifyInput {
  idImage: Buffer;
  idImageMime: string;
  liveFaceImage: Buffer;
  expectedName: string;
  expectedBirthDate?: string;
  /** When set, the verified live-face is stored as the user's reference face on PASS. */
  userId?: string;
  /** Optional CBT exam session that triggered this verification. */
  examSessionId?: string;
}

const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const MAX_BYTES = 8 * 1024 * 1024;

// Particles common in Uzbek / Arab / Spanish / Dutch account names that don't
// always appear on Korean foreign-resident cards.
const NAME_PARTICLES = new Set([
  'ugli', 'ugl', 'oglu', 'ogly', 'ogli', 'kyzy', 'qizi', 'kizi',
  'bin', 'binti', 'bint', 'al', 'el', 'de', 'da', 'do', 'di',
  'von', 'van', 'der', 'den', 'le', 'la', 'mc', 'mac',
  'jr', 'sr', 'ii', 'iii',
]);

@Injectable()
export class IdentityVerificationService {
  private readonly logger = new Logger(IdentityVerificationService.name);

  constructor(
    private readonly clova: ClovaOcrService,
    private readonly rekognition: AwsRekognitionService,
    private readonly faceReference: FaceReferenceService,
    private readonly prisma: PrismaService,
  ) {}

  async verify(input: VerifyInput): Promise<IdentityVerificationResult> {
    this.assertImage(input.idImage, input.idImageMime, 'ID card');
    this.assertImage(input.liveFaceImage, 'image/jpeg', 'live face');

    const idCard = await this.clova.extractIdCard(input.idImage, input.idImageMime);

    const nameMatch = this.matchName(input.expectedName, idCard.name);
    const birthDateMatch = input.expectedBirthDate
      ? this.matchBirthDate(input.expectedBirthDate, idCard.birthDate)
      : null;

    const faceMatch = await this.runFaceMatch(input.idImage, input.liveFaceImage);

    const reasons: string[] = [];
    if (!nameMatch.matched) reasons.push('NAME_MISMATCH');
    if (birthDateMatch && !birthDateMatch.matched) reasons.push('BIRTHDATE_MISMATCH');
    if (idCard.idType === 'UNKNOWN') reasons.push('ID_TYPE_UNKNOWN');
    if (idCard.rawConfidence < 0.6) reasons.push('LOW_OCR_CONFIDENCE');
    if (faceMatch.decision === 'NO_MATCH') {
      if (faceMatch.sourceFaceCount === 0) reasons.push('NO_FACE_ON_ID');
      else if (faceMatch.targetFaceCount === 0) reasons.push('NO_FACE_IN_SELFIE');
      else reasons.push('FACE_MISMATCH');
    }
    if (faceMatch.decision === 'REVIEW') {
      if (faceMatch.targetFaceCount > 1) reasons.push('MULTIPLE_FACES_IN_SELFIE');
      else reasons.push('FACE_LOW_SIMILARITY');
    }
    if (faceMatch.decision === 'SKIPPED') reasons.push('FACE_CHECK_UNAVAILABLE');

    const verdict = this.decide(nameMatch, birthDateMatch, idCard, faceMatch);

    // Persist the verified live-face as the in-exam reference image. Only on
    // PASS — REVIEW/FAIL must not seed a reference that would later mask an
    // imposter swap with a low-confidence match.
    // ID card bytes are intentionally discarded here and never written to DB.
    if (verdict === 'PASS' && input.userId) {
      try {
        await this.faceReference.setExamReference(input.userId, input.liveFaceImage);
      } catch (err) {
        this.logger.warn(
          `Failed to persist reference face for user=${input.userId}: ${(err as Error).message}`,
        );
      }
    }

    if (input.userId) {
      await this.recordAttempt({
        userId: input.userId,
        examSessionId: input.examSessionId,
        verdict,
        reasons,
        idType: idCard.idType,
        ocrConfidence: idCard.rawConfidence,
        nameMatched: nameMatch.matched,
        birthDateMatched: birthDateMatch?.matched ?? null,
        faceDecision: faceMatch.decision,
        faceSimilarity: faceMatch.similarity,
      });
    }

    this.logger.log(
      `Identity verdict=${verdict} reasons=[${reasons.join(',')}] ` +
        `name_ok=${nameMatch.matched} dob_ok=${birthDateMatch?.matched ?? 'n/a'} ` +
        `id_type=${idCard.idType} ocr_conf=${idCard.rawConfidence.toFixed(2)} ` +
        `face_decision=${faceMatch.decision} face_sim=${faceMatch.similarity.toFixed(1)} ` +
        `selfie_bytes=${input.liveFaceImage.length}`,
    );

    return {
      verdict,
      reasons,
      idCard,
      nameMatch,
      birthDateMatch,
      faceMatch,
      liveness: {
        selfieReceived: input.liveFaceImage.length > 0,
        selfieByteSize: input.liveFaceImage.length,
      },
    };
  }

  /**
   * Structured audit row only — never stores ID-card or selfie image bytes.
   * Failures here must not block the examinee response.
   */
  private async recordAttempt(row: {
    userId: string;
    examSessionId?: string;
    verdict: IdentityVerdict;
    reasons: string[];
    idType: string;
    ocrConfidence: number;
    nameMatched: boolean;
    birthDateMatched: boolean | null;
    faceDecision: string;
    faceSimilarity: number;
  }): Promise<void> {
    try {
      await this.prisma.identityVerificationAttempt.create({
        data: {
          userId: row.userId,
          examSessionId: row.examSessionId ?? null,
          verdict: row.verdict,
          reasons: row.reasons,
          idType: row.idType,
          ocrConfidence: row.ocrConfidence,
          nameMatched: row.nameMatched,
          birthDateMatched: row.birthDateMatched,
          faceDecision: row.faceDecision,
          faceSimilarity: row.faceSimilarity,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to record identity attempt for user=${row.userId}: ${(err as Error).message}`,
      );
    }
  }

  private async runFaceMatch(
    idImage: Buffer,
    liveFaceImage: Buffer,
  ): Promise<FaceMatchSummary> {
    try {
      const r = await this.rekognition.compareFaces(idImage, liveFaceImage);
      return {
        decision: r.decision,
        similarity: r.similarity,
        sourceFaceCount: r.sourceFaceCount,
        targetFaceCount: r.targetFaceCount,
        matched: r.decision === 'MATCH',
      };
    } catch (err) {
      // Rekognition unavailable / not configured — degrade to REVIEW rather than
      // blocking the user. Operator must fix configuration to get PASS verdicts.
      if (err instanceof ServiceUnavailableException) {
        this.logger.warn('AWS Rekognition not configured — face match skipped');
        return this.skippedFaceResult('NOT_CONFIGURED');
      }
      this.logger.error(`Face match failed: ${(err as Error).message}`);
      return this.skippedFaceResult('SERVICE_ERROR');
    }
  }

  private skippedFaceResult(reason: string): FaceMatchSummary {
    return {
      decision: 'SKIPPED',
      similarity: 0,
      sourceFaceCount: 0,
      targetFaceCount: 0,
      matched: false,
      skippedReason: reason,
    };
  }

  private decide(
    nameMatch: FieldMatch,
    birthDateMatch: FieldMatch | null,
    idCard: KoreanIdCardData,
    faceMatch: FaceMatchSummary,
  ): IdentityVerdict {
    if (!nameMatch.matched) return 'FAIL';
    if (birthDateMatch && !birthDateMatch.matched) return 'FAIL';
    if (faceMatch.decision === 'NO_MATCH') return 'FAIL';
    if (faceMatch.decision === 'REVIEW') return 'REVIEW';
    if (faceMatch.decision === 'SKIPPED') return 'REVIEW';
    if (idCard.idType === 'UNKNOWN') return 'REVIEW';
    if (idCard.rawConfidence < 0.6) return 'REVIEW';
    return 'PASS';
  }

  /**
   * Name matching strategy:
   *   - If both sides contain Hangul → strict whitespace-stripped equality.
   *   - Otherwise (Latin names, including foreign-resident cards) → token-set
   *     comparison after stripping diacritics and patronymic particles. This
   *     handles cases like account "Rakhmonaliev Rakhmatillo Khasanali ugl"
   *     vs OCR "RAKHMONALIEV RAKHMATILLO" (the card omits patronymics).
   */
  private matchName(expected: string, actual: string | null): FieldMatch {
    if (!actual) return { expected, actual, matched: false };
    const expHasHangul = /[가-힣]/.test(expected);
    const actHasHangul = /[가-힣]/.test(actual);

    if (expHasHangul && actHasHangul) {
      const a = expected.replace(/\s+/g, '').trim();
      const b = actual.replace(/\s+/g, '').trim();
      return { expected, actual, matched: a === b };
    }

    const matched = this.latinTokenMatch(expected, actual);
    return { expected, actual, matched };
  }

  private latinTokenMatch(a: string, b: string): boolean {
    const ta = this.tokenize(a);
    const tb = this.tokenize(b);
    if (ta.size === 0 || tb.size === 0) return false;

    const intersection = new Set<string>();
    for (const t of ta) if (tb.has(t)) intersection.add(t);
    const union = new Set<string>([...ta, ...tb]);
    const jaccard = intersection.size / union.size;

    if (intersection.size >= 2 && jaccard >= 0.5) return true;
    if (intersection.size >= 1) {
      const aSubset = [...ta].every((x) => tb.has(x));
      const bSubset = [...tb].every((x) => ta.has(x));
      if (aSubset || bSubset) return true;
    }
    return false;
  }

  private tokenize(s: string): Set<string> {
    const lower = s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    const cleaned = lower.replace(/[^a-z\s'-]/g, ' ');
    const parts = cleaned
      .split(/\s+/)
      .map((t) => t.replace(/^[-']+|[-']+$/g, ''))
      .filter((t) => t.length >= 2 && !NAME_PARTICLES.has(t));
    return new Set(parts);
  }

  private matchBirthDate(expected: string, actual: string | null): FieldMatch {
    return { expected, actual, matched: actual !== null && expected === actual };
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

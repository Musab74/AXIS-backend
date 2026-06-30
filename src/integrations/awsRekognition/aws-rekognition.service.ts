import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CompareFacesCommand,
  DetectFacesCommand,
  RekognitionClient,
} from '@aws-sdk/client-rekognition';

export type FaceMatchDecision = 'MATCH' | 'REVIEW' | 'NO_MATCH' | 'INDETERMINATE';

export interface FaceCompareResult {
  decision: FaceMatchDecision;
  similarity: number;       // 0..100
  matchedFaceCount: number; // # faces in target that matched the source above the API threshold
  unmatchedFaceCount: number;
  sourceFaceCount: number;  // # faces detected in source (the ID photo)
  targetFaceCount: number;  // # faces detected in target (the live frame)
}

const MATCH_THRESHOLD = 85;
const REVIEW_THRESHOLD = 70;
const API_SIMILARITY_THRESHOLD = REVIEW_THRESHOLD; // ask Rekognition for anything ≥ 70

@Injectable()
export class AwsRekognitionService {
  private readonly logger = new Logger(AwsRekognitionService.name);
  private readonly client: RekognitionClient | null;

  constructor(private readonly config: ConfigService) {
    const accessKeyId = config.get<string>('aws.accessKeyId');
    const secretAccessKey = config.get<string>('aws.secretAccessKey');
    const region = config.get<string>('aws.region') ?? 'ap-northeast-2';

    if (!accessKeyId || !secretAccessKey) {
      this.client = null;
      return;
    }

    this.client = new RekognitionClient({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async compareFaces(sourceImage: Buffer, targetImage: Buffer): Promise<FaceCompareResult> {
    const client = this.requireClient();

    const sourceFaceCount = await this.countFaces(client, sourceImage);
    const targetFaceCount = await this.countFaces(client, targetImage);

    if (sourceFaceCount === 0) {
      // The reference (ID photo or demo-start seed) has no face. This is a
      // *system* fault, not a cheating signal — returning NO_MATCH would
      // falsely accuse every subsequent check ("another user appeared"). Use
      // INDETERMINATE so the controller surfaces matched=null.
      this.logger.warn('No face detected in reference image — returning INDETERMINATE');
      return this.zeroResult('INDETERMINATE', sourceFaceCount, targetFaceCount);
    }
    if (targetFaceCount === 0) {
      // No face in the live frame — the presence verdict (NO_FACE) already
      // covers this; an identity decision here would just spam IDENTITY_MISMATCH.
      this.logger.warn('No face detected in live frame — returning INDETERMINATE');
      return this.zeroResult('INDETERMINATE', sourceFaceCount, targetFaceCount);
    }
    if (targetFaceCount > 1) {
      this.logger.warn(`Multiple faces (${targetFaceCount}) in live frame — flagging review`);
    }

    let response;
    try {
      response = await client.send(
        new CompareFacesCommand({
          SourceImage: { Bytes: sourceImage },
          TargetImage: { Bytes: targetImage },
          SimilarityThreshold: API_SIMILARITY_THRESHOLD,
          QualityFilter: 'AUTO',
        }),
      );
    } catch (err) {
      this.logger.error('Rekognition CompareFaces failed', err);
      throw new BadGatewayException('Face comparison service failed');
    }

    const matches = response.FaceMatches ?? [];
    const unmatched = response.UnmatchedFaces ?? [];
    const topSimilarity = matches.reduce(
      (max, m) => Math.max(max, m.Similarity ?? 0),
      0,
    );

    let decision: FaceMatchDecision;
    if (topSimilarity >= MATCH_THRESHOLD && targetFaceCount === 1) {
      decision = 'MATCH';
    } else if (topSimilarity >= REVIEW_THRESHOLD || targetFaceCount > 1) {
      decision = 'REVIEW';
    } else {
      decision = 'NO_MATCH';
    }

    this.logger.log(
      `Face compare: similarity=${topSimilarity.toFixed(2)} ` +
        `decision=${decision} src_faces=${sourceFaceCount} tgt_faces=${targetFaceCount}`,
    );

    return {
      decision,
      similarity: topSimilarity,
      matchedFaceCount: matches.length,
      unmatchedFaceCount: unmatched.length,
      sourceFaceCount,
      targetFaceCount,
    };
  }

  private async countFaces(client: RekognitionClient, image: Buffer): Promise<number> {
    try {
      const res = await client.send(
        new DetectFacesCommand({ Image: { Bytes: image }, Attributes: ['DEFAULT'] }),
      );
      return res.FaceDetails?.length ?? 0;
    } catch (err) {
      this.logger.error('Rekognition DetectFaces failed', err);
      throw new BadGatewayException('Face detection service failed');
    }
  }

  /**
   * Lightweight liveness/gaze check used during the exam — returns face count plus a
   * yaw/pitch-based "looking at screen" verdict. Rekognition's Pose returns degrees
   * (negative yaw = looking right, positive pitch = looking down). Anything inside
   * |25°| we consider "facing forward".
   */
  async checkFacePresence(image: Buffer): Promise<{
    faceCount: number;
    lookingForward: boolean;
    eyesOpen: boolean | null;
    yaw: number | null;
    pitch: number | null;
  }> {
    const client = this.requireClient();
    let res;
    try {
      res = await client.send(
        new DetectFacesCommand({ Image: { Bytes: image }, Attributes: ['ALL'] }),
      );
    } catch (err) {
      this.logger.error('Rekognition DetectFaces (presence) failed', err);
      throw new BadGatewayException('Face presence check failed');
    }
    const faces = res.FaceDetails ?? [];
    if (faces.length === 0) {
      return { faceCount: 0, lookingForward: false, eyesOpen: null, yaw: null, pitch: null };
    }
    // Pick the largest face (closest to camera) for monitoring
    const main = faces.reduce((best, f) => {
      const a = (f.BoundingBox?.Width ?? 0) * (f.BoundingBox?.Height ?? 0);
      const b = (best.BoundingBox?.Width ?? 0) * (best.BoundingBox?.Height ?? 0);
      return a > b ? f : best;
    }, faces[0]);
    const yaw = main.Pose?.Yaw ?? null;
    const pitch = main.Pose?.Pitch ?? null;
    const eyesOpen = main.EyesOpen?.Value ?? null;
    // Looking-forward band tightened to match the client face-api thresholds
    // (|yaw| > 18° OR pitch < -12° fires the local LOOK_AWAY in
    // useProctorMonitorLive.tsx). Pitch downward is the "looking at lap/phone"
    // tell — bound it to >= -15°. Pitch upward (head leaning back) is fine,
    // bound it to a generous <= 25°. See proctor-detection-gap-fix plan, gap 3.
    const lookingForward =
      yaw != null &&
      pitch != null &&
      Math.abs(yaw) <= 18 &&
      pitch >= -15 &&
      pitch <= 25;
    return { faceCount: faces.length, lookingForward, eyesOpen, yaw, pitch };
  }

  private requireClient(): RekognitionClient {
    if (!this.client) {
      throw new ServiceUnavailableException('AWS Rekognition not configured');
    }
    return this.client;
  }

  private zeroResult(
    decision: FaceMatchDecision,
    sourceFaceCount: number,
    targetFaceCount: number,
  ): FaceCompareResult {
    return {
      decision,
      similarity: 0,
      matchedFaceCount: 0,
      unmatchedFaceCount: 0,
      sourceFaceCount,
      targetFaceCount,
    };
  }
}

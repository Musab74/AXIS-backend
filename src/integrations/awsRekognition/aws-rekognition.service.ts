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

export type FaceMatchDecision = 'MATCH' | 'REVIEW' | 'NO_MATCH';

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
      this.logger.warn('No face detected in ID photo');
      return this.zeroResult('NO_MATCH', sourceFaceCount, targetFaceCount);
    }
    if (targetFaceCount === 0) {
      this.logger.warn('No face detected in live frame');
      return this.zeroResult('NO_MATCH', sourceFaceCount, targetFaceCount);
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

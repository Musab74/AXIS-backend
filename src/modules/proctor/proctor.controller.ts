import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AwsRekognitionService } from '../../integrations/awsRekognition/aws-rekognition.service';
import { FaceReferenceService } from './face-reference.service';
import { AdminMonitorGateway } from '../adminMonitor/admin-monitor.gateway';
import { MonitorHeartbeatService } from '../adminMonitor/monitor-heartbeat.service';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../integrations/redis/redis.service';
import { ExamSessionStatus } from '@prisma/client';

class FaceCheckDto {
  /** base64-encoded JPEG/PNG (no data: prefix). Sent ~ every 30s during the exam. */
  @IsString()
  imageBase64!: string;

  /** Optional context for logs — purpose=DEMO|EXAM, sessionId */
  @IsOptional()
  @IsString()
  purpose?: 'DEMO' | 'EXAM';

  @IsOptional()
  @IsString()
  sessionId?: string;
}

class DemoReferenceDto {
  /** base64-encoded JPEG of the demo-taker's live face, captured at Start. */
  @IsString()
  imageBase64!: string;
}

class MonitorThumbDto {
  @IsString()
  @Length(1, 64)
  sessionId!: string;

  /** Base64 JPEG, no data: prefix. Frontend keeps this ≤ ~32 KB. */
  @IsString()
  @Length(1, 200_000)
  imageBase64!: string;

  @IsInt()
  @Min(0)
  ts!: number;
}

@ApiTags('Proctor')
@Controller('cbt/proctor')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ProctorController {
  private readonly logger = new Logger(ProctorController.name);

  constructor(
    private readonly rekognition: AwsRekognitionService,
    private readonly faceReference: FaceReferenceService,
    private readonly adminMonitor: AdminMonitorGateway,
    private readonly heartbeat: MonitorHeartbeatService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Live face presence + gaze + identity check — called periodically by the
   * exam runner. The verdict drives the client banner; `identityMatched`
   * drives the IDENTITY_MISMATCH event (and termination on the demo).
   *
   * Identity recheck is best-effort: it runs only if a reference face is
   * available for this user/scope, and a Rekognition error degrades it to
   * `null` (don't block the exam on AWS hiccups).
   */
  @Post('face-check')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Live face/gaze/identity check for proctoring' })
  async faceCheck(@CurrentUser('id') userId: string, @Body() dto: FaceCheckDto) {
    if (dto.sessionId) await this.heartbeat.markAlive(dto.sessionId);
    const buf = decodeBase64Image(dto.imageBase64);
    const presence = await this.rekognition.checkFacePresence(buf);

    const rawVerdict =
      presence.faceCount === 0
        ? 'NO_FACE'
        : presence.faceCount > 1
        ? 'MULTIPLE_FACES'
        : !presence.lookingForward
        ? 'LOOK_AWAY'
        : presence.eyesOpen === false
        ? 'EYES_CLOSED'
        : 'OK';

    // Debounce EYES_CLOSED across two consecutive ticks per session — a
    // single closed-eye sample is far more likely to be a normal blink than
    // someone falling asleep. Only emit EYES_CLOSED if we saw the same state
    // on the previous face-check tick (Redis TTL 90s — generous given
    // face-check cadence is 10s on the client). When Redis is offline we
    // fail-OPEN (no debounce) — a few extra strikes on a single blink are
    // preferable to ignoring real sleep behavior.
    const verdict = await this.debounceEyesClosed(rawVerdict, dto.sessionId);

    const purpose = dto.purpose ?? 'EXAM';
    const identity = await this.maybeCheckIdentity(userId, buf, purpose, presence.faceCount);

    return {
      verdict,
      faceCount: presence.faceCount,
      lookingForward: presence.lookingForward,
      eyesOpen: presence.eyesOpen,
      yaw: presence.yaw,
      pitch: presence.pitch,
      identityMatched: identity.matched,
      identitySimilarity: identity.similarity,
      identityChecked: identity.checked,
      checkedAt: new Date().toISOString(),
      userId,
      purpose,
      sessionId: dto.sessionId ?? null,
    };
  }

  /**
   * 2-tick debounce for EYES_CLOSED. Returns the original verdict for every
   * non-eyes case; for EYES_CLOSED, returns 'OK' on the first sighting and
   * 'EYES_CLOSED' only when the previous tick was also eyes-closed within the
   * TTL window. Without `sessionId` (some demo / smoke flows omit it) the
   * debounce is bypassed.
   */
  private async debounceEyesClosed(
    verdict: string,
    sessionId: string | undefined,
  ): Promise<string> {
    if (!sessionId) return verdict;
    const key = `proctor:eyes-closed:${sessionId}`;
    if (verdict !== 'EYES_CLOSED') {
      // Any non-closed tick clears the streak.
      try {
        await this.redis.set(key, '0', 90);
      } catch {
        // ignore — fail-OPEN
      }
      return verdict;
    }
    if (!this.redis.isReady()) return verdict;
    let last: string | null = null;
    try {
      last = await this.redis.get(key);
    } catch {
      return verdict; // fail-OPEN
    }
    try {
      await this.redis.set(key, '1', 90);
    } catch {
      // ignore — fail-OPEN
    }
    if (last === '1') return 'EYES_CLOSED';
    return 'OK';
  }

  /**
   * Capture-at-Start reference for the demo. The frame is held in-process
   * with a 60-min TTL — we never persist demo selfies (PIPA). On a roommate
   * swap mid-demo, the next 30s face-check tick will compare against this
   * frame and the client terminates the demo on a mismatch.
   */
  @Post('demo-reference')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Set the demo-scope reference face (in-memory only)' })
  setDemoReference(
    @CurrentUser('id') userId: string,
    @Body() dto: DemoReferenceDto,
  ): { stored: true; bytes: number } {
    const buf = decodeBase64Image(dto.imageBase64);
    this.faceReference.setDemoReference(userId, buf);
    return { stored: true, bytes: buf.length };
  }

  /**
   * Live webcam thumbnail for the admin monitor — fanned out via Redis to
   * `monitor:webcam-frame` and consumed by the admin live page. The frame is
   * NEVER persisted (no DB write, no object storage); it lives only in the
   * Redis pub/sub stream long enough to reach connected admin sockets.
   */
  @Post('webcam-thumb')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Live webcam thumbnail (in-memory, admin fan-out)' })
  async webcamThumb(
    @CurrentUser('id') userId: string,
    @Body() dto: MonitorThumbDto,
  ): Promise<{ ok: true }> {
    await this.requireOwnedSession(userId, dto.sessionId);
    await this.heartbeat.markWebcam(dto.sessionId, dto.ts);
    await this.adminMonitor.emitWebcamFrame({
      sessionId: dto.sessionId,
      imageBase64: dto.imageBase64,
      ts: dto.ts,
    });
    return { ok: true };
  }

  /**
   * Live screen-capture thumbnail for the admin monitor. Same in-memory
   * Redis-only path as `webcam-thumb` — never written to the database.
   */
  @Post('screen-thumb')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Live screen-capture thumbnail (in-memory, admin fan-out)' })
  async screenThumb(
    @CurrentUser('id') userId: string,
    @Body() dto: MonitorThumbDto,
  ): Promise<{ ok: true }> {
    await this.requireOwnedSession(userId, dto.sessionId);
    await this.heartbeat.markScreen(dto.sessionId, dto.ts);
    await this.adminMonitor.emitScreenFrame({
      sessionId: dto.sessionId,
      imageBase64: dto.imageBase64,
      ts: dto.ts,
    });
    return { ok: true };
  }

  /**
   * Verify that `userId` owns `sessionId` and that the session is live. We
   * cache positive verifications in Redis for 5 min so the 5 s frame cadence
   * doesn't translate into one Prisma round-trip per frame in steady state.
   */
  private async requireOwnedSession(userId: string, sessionId: string): Promise<void> {
    const cacheKey = `proctor:thumb:owner:${userId}:${sessionId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached === 'ok') return;
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      select: { userId: true, status: true },
    });
    if (!session || session.userId !== userId) {
      throw new ForbiddenException('Not your session');
    }
    if (session.status !== ExamSessionStatus.IN_PROGRESS) {
      throw new ForbiddenException(`Session is ${session.status}, not IN_PROGRESS`);
    }
    await this.redis.set(cacheKey, 'ok', 300);
  }

  private async maybeCheckIdentity(
    userId: string,
    incoming: Buffer,
    purpose: 'DEMO' | 'EXAM',
    faceCount: number,
  ): Promise<{ matched: boolean | null; similarity: number | null; checked: boolean }> {
    // Skip when there's no single face to compare — presence verdict already
    // drives the banner for those cases.
    if (faceCount !== 1) {
      return { matched: null, similarity: null, checked: false };
    }
    const reference =
      purpose === 'DEMO'
        ? this.faceReference.getDemoReference(userId)
        : await this.faceReference.getExamReference(userId);
    if (!reference) {
      return { matched: null, similarity: null, checked: false };
    }
    try {
      const r = await this.rekognition.compareFaces(reference, incoming);
      // Decision → matched mapping (per §7.3 of CLAUDE.md):
      //   MATCH (≥85)         → matched=true   (clearly the same person)
      //   NO_MATCH (<70)      → matched=false  (clearly a different person)
      //   REVIEW (70–85)      → matched=null   (queue for human review, do NOT
      //                                         terminate — would false-fire
      //                                         IDENTITY_MISMATCH on lighting
      //                                         changes, head turns, etc.)
      //   INDETERMINATE       → matched=null   (system fault — bad reference
      //                                         seed or live frame had no face;
      //                                         not a cheating signal)
      let matched: boolean | null;
      if (r.decision === 'MATCH') matched = true;
      else if (r.decision === 'NO_MATCH') matched = false;
      else matched = null;
      if (r.decision === 'REVIEW') {
        this.logger.log(
          `Identity recheck flagged for review user=${userId} purpose=${purpose} similarity=${r.similarity.toFixed(2)}`,
        );
      }
      return {
        matched,
        similarity: r.similarity,
        checked: true,
      };
    } catch (err) {
      // Don't block the exam on a transient Rekognition failure — surface as
      // "not checked" and let the next tick try again.
      this.logger.warn(
        `Identity recheck failed user=${userId} purpose=${purpose}: ${(err as Error).message}`,
      );
      return { matched: null, similarity: null, checked: false };
    }
  }
}

function decodeBase64Image(s: string): Buffer {
  // Accept "data:image/jpeg;base64,XYZ" or raw "XYZ"
  const stripped = s.replace(/^data:image\/[a-z]+;base64,/, '');
  if (!stripped) throw new BadRequestException('Empty image');
  const buf = Buffer.from(stripped, 'base64');
  if (buf.length === 0) throw new BadRequestException('Invalid base64 image');
  if (buf.length > 4 * 1024 * 1024) throw new BadRequestException('Image too large (max 4MB)');
  return buf;
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import 'multer';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AiProctorService } from './ai-proctor.service';
import {
  AiReviewRequestDto,
  DemoAiReviewDto,
  DemoEvidenceDto,
  DemoVoiceClipMetadataDto,
  VoiceClipMetadataDto,
} from './ai-proctor.dto';

@ApiTags('Proctor — AI')
@Controller()
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AiProctorController {
  constructor(private readonly svc: AiProctorService) {}

  /**
   * Tier-1 (Gemini Flash-Lite) screen → Tier-2 (Claude Sonnet 4.6) verify.
   * The frontend posts every 3s; throttle at 20/min/session (60÷3).
   */
  @Post('cbt/proctor/ai-review')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Two-tier AI screening of a single webcam frame' })
  async aiReview(
    @CurrentUser('id') userId: string,
    @Body() dto: AiReviewRequestDto,
  ) {
    const result = await this.svc.review(userId, {
      sessionId: dto.sessionId,
      ts: dto.ts,
      imageBase64: dto.imageBase64,
      screenImageBase64: dto.screenImageBase64,
    });
    return result;
  }

  /**
   * Demo-only AI screening. Gemini tier-1 only — no session validation, no
   * evidence persistence. Throttled per-user (6/min) to limit API spend.
   */
  @Post('cbt/proctor/demo-ai-review')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @ApiOperation({ summary: 'Demo-only AI screening (Gemini tier-1, no persistence)' })
  async demoAiReview(
    @Body() dto: DemoAiReviewDto,
  ) {
    return this.svc.demoReview(dto.imageBase64, dto.ts);
  }

  /**
   * Voice burst — webm clip + optional still frame. Throttled 6/min/session.
   * Body is multipart: `clip` (webm), optional `still` (jpeg), plus form fields
   * mirroring VoiceClipMetadataDto.
   */
  @Post('cbt/proctor/voice-clip')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'clip', maxCount: 1 },
        { name: 'still', maxCount: 1 },
      ],
      { limits: { fileSize: 8 * 1024 * 1024 } },
    ),
  )
  @ApiOperation({ summary: 'Upload a 10s rolling audio clip + still frame' })
  async voiceClip(
    @CurrentUser('id') userId: string,
    @UploadedFiles()
    files: { clip?: Express.Multer.File[]; still?: Express.Multer.File[] },
    @Body() dto: VoiceClipMetadataDto,
  ) {
    const clip = files.clip?.[0];
    if (!clip || !clip.buffer || clip.size === 0) {
      throw new BadRequestException('Missing clip file');
    }
    const still = files.still?.[0];
    return this.svc.recordVoiceClip(userId, {
      sessionId: dto.sessionId,
      ts: dto.ts,
      peakDb: dto.peakDb,
      durationMs: dto.durationMs,
      clipBuffer: clip.buffer,
      clipMime: clip.mimetype || 'video/webm',
      stillFrame: still?.buffer ?? null,
    });
  }

  /** Student-side: list their own session's AI evidence. */
  @Get('cbt/sessions/:id/proctor/evidence')
  @ApiOperation({ summary: 'List AI evidence for the calling user’s session' })
  async myEvidence(
    @CurrentUser('id') userId: string,
    @Param('id') sessionId: string,
  ) {
    return { items: await this.svc.listEvidenceForUser(userId, sessionId) };
  }

  /**
   * Persist a single demo-violation screenshot. Mirrors `aiReview` evidence
   * persistence but routes to the demo table (no session FK). Throttled
   * 30/min/user — demos can fire bursts of violations near the start.
   */
  @Post('cbt/demo/proctor/evidence')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Upload demo-run violation screenshot' })
  async demoEvidence(
    @CurrentUser('id') userId: string,
    @Body() dto: DemoEvidenceDto,
  ) {
    return this.svc.recordDemoEvidence(userId, {
      ts: dto.ts,
      kind: dto.kind,
      imageBase64: dto.imageBase64,
      severity: dto.severity,
    });
  }

  /**
   * Demo-run voice clip + optional still frame. Same multipart shape as
   * `/cbt/proctor/voice-clip` but with no sessionId in the metadata.
   */
  @Post('cbt/demo/proctor/voice-clip')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'clip', maxCount: 1 },
        { name: 'still', maxCount: 1 },
      ],
      { limits: { fileSize: 8 * 1024 * 1024 } },
    ),
  )
  @ApiOperation({ summary: 'Upload demo-run rolling audio clip + still frame' })
  async demoVoiceClip(
    @CurrentUser('id') userId: string,
    @UploadedFiles()
    files: { clip?: Express.Multer.File[]; still?: Express.Multer.File[] },
    @Body() dto: DemoVoiceClipMetadataDto,
  ) {
    const clip = files.clip?.[0];
    if (!clip || !clip.buffer || clip.size === 0) {
      throw new BadRequestException('Missing clip file');
    }
    const still = files.still?.[0];
    return this.svc.recordDemoVoiceClip(userId, {
      ts: dto.ts,
      peakDb: dto.peakDb,
      durationMs: dto.durationMs,
      clipBuffer: clip.buffer,
      clipMime: clip.mimetype || 'video/webm',
      stillFrame: still?.buffer ?? null,
    });
  }

  /** List the calling user's persisted demo evidence (all runs). */
  @Get('cbt/demo/proctor/evidence')
  @ApiOperation({ summary: 'List the caller’s demo evidence (all runs)' })
  async demoMyEvidence(@CurrentUser('id') userId: string) {
    return { items: await this.svc.listDemoEvidenceForUser(userId) };
  }
}

@ApiTags('Admin — AI evidence')
@Controller('admin/sessions')
@UseGuards(JwtAuthGuard, RolesGuard)
// Role names MUST match the Prisma `Role` enum verbatim (UPPERCASE) — the
// `RolesGuard` does an exact-string `includes()` check on the JWT's roles
// array, and `JwtStrategy.validate()` populates that array with the raw
// enum values. Lowercase strings here would never match → 403 for every
// admin, which is what produced the "Forbidden resource" error in the
// Examinees → Cheating evidence modal.
@Roles('PROCTOR', 'EXAM_ADMIN', 'SUPER_ADMIN', 'GRADING_ADMIN', 'EXPERT')
@ApiBearerAuth()
export class AdminAiEvidenceController {
  constructor(private readonly svc: AiProctorService) {}

  @Get(':id/proctor/evidence')
  @ApiOperation({ summary: 'Admin: list AI evidence for any session' })
  async list(@Param('id') sessionId: string) {
    return { items: await this.svc.listEvidenceForAdmin(sessionId) };
  }
}


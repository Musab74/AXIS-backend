import { Body, Controller, Get, Ip, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CbtSessionsService } from './cbt-sessions.service';
import {
  ConsentDto,
  CreateSessionDto,
  MicDisconnectedDto,
  ProctorEventDto,
  VoiceStrikeThresholdDto,
} from './cbt-sessions.dto';

@Controller('cbt/sessions')
@UseGuards(JwtAuthGuard)
export class CbtSessionsController {
  constructor(private readonly svc: CbtSessionsService) {}

  /**
   * Admin / proctor tool — creates a session for any cert+level without a
   * paid registration.  Regular candidates must use POST /from-registration,
   * which enforces payment and schedule window.
   */
  @Post()
  @UseGuards(RolesGuard)
  // UPPERCASE — must match the Prisma `Role` enum exactly (the JWT carries
  // raw enum values; `RolesGuard.canActivate` does an exact `includes()`).
  @Roles('EXAM_ADMIN', 'SUPER_ADMIN')
  create(@CurrentUser('id') userId: string, @Body() dto: CreateSessionDto) {
    return this.svc.create(userId, dto.certType, dto.level);
  }

  @Post('from-registration')
  createFromRegistration(
    @CurrentUser('id') userId: string,
    @Body() body: { registrationId: string },
  ) {
    return this.svc.createFromRegistration(userId, body.registrationId);
  }

  @Get('mine')
  mine(@CurrentUser('id') userId: string) {
    return this.svc.listMine(userId);
  }

  @Get(':id')
  get(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.getOwned(userId, id);
  }

  @Post(':id/consent')
  consent(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ConsentDto,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.svc.recordConsent(userId, id, dto, {
      ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Post(':id/start')
  start(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.start(userId, id);
  }

  @Post(':id/proctor/event')
  proctorEvent(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ProctorEventDto,
  ) {
    return this.svc.recordProctorEvent(userId, id, dto.type, dto.detail, {
      webcamFrameBase64: dto.webcamFrameBase64,
      screenFrameBase64: dto.screenFrameBase64,
    });
  }

  /**
   * Hard-violation: candidate's microphone has been unplugged or stopped
   * delivering audio for longer than the grace window. Terminates the session
   * immediately (Article 28 — mic is mandatory for the duration of the exam).
   */
  @Post(':id/proctor/mic-disconnected')
  micDisconnected(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: MicDisconnectedDto,
  ) {
    return this.svc.terminateForMicDisconnect(userId, id, {
      reason: dto.reason,
      detail: dto.detail,
    });
  }

  /**
   * Voice-strike threshold reached — the candidate produced enough sustained
   * voice bursts during the exam to exhaust the audio strike budget. Without
   * this call the client-side termination would leave the DB row stuck in
   * IN_PROGRESS even though the candidate has already been navigated to the
   * result page (see `ExamRunnerPage.handleMicEvent`). Idempotent.
   */
  @Post(':id/proctor/voice-strike-threshold')
  voiceStrikeThreshold(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: VoiceStrikeThresholdDto,
  ) {
    return this.svc.terminateForVoiceStrikes(userId, id, {
      strikes: dto.strikes,
      detail: dto.detail,
    });
  }
}

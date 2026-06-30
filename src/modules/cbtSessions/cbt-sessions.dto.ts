import {
  Equals,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { CertType, CertLevel, ProctorEventType } from '@prisma/client';

export class CreateSessionDto {
  @IsEnum(CertType)
  certType!: CertType;

  @IsEnum(CertLevel)
  level!: CertLevel;
}

export class SaveAnswerDto {
  @IsString()
  questionId!: string;

  @IsOptional()
  @IsString()
  selectedChoice?: string | null;

  @IsOptional()
  flagged?: boolean;

  @IsInt()
  @Min(0)
  version!: number;
}

export class ProctorEventDto {
  @IsEnum(ProctorEventType)
  type!: ProctorEventType;

  @IsOptional()
  @IsObject()
  detail?: Record<string, unknown>;

  /**
   * Optional webcam still (base64 JPEG/PNG, with or without data: prefix)
   * captured by the client at the exact moment of the violation. When present
   * it is uploaded and attached as the event's evidence snapshot — independent
   * of whether an admin is live-monitoring.
   */
  @IsOptional()
  @IsString()
  webcamFrameBase64?: string;

  /** Optional screen still captured at the moment of the violation. */
  @IsOptional()
  @IsString()
  screenFrameBase64?: string;
}

/**
 * Hard-violation report — the candidate's microphone has been unplugged or
 * stopped producing audio for longer than the grace window. There is no
 * legitimate reason for a proctored candidate to lose the mic mid-exam, so
 * unlike strike-class events this fires immediate termination on the first
 * report. Detail payload mirrors the optional fields the candidate hook
 * currently sends (reason: 'ENDED' | 'MUTED' | 'STOPPED', durationMs, etc.).
 */
export class MicDisconnectedDto {
  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsObject()
  detail?: Record<string, unknown>;
}

/**
 * Voice-strike threshold report — the candidate accumulated the maximum
 * number of sustained voice bursts permitted during the exam (currently 3,
 * see VOICE_STRIKE_THRESHOLD on the client). This is the audio analogue of
 * the fullscreen-exit strike threshold: each individual burst is already
 * persisted as an `AUDIO_HIGH` evidence row by the voice-clip pipeline, but
 * the *threshold-reached* event needs an explicit termination signal so the
 * session row flips from IN_PROGRESS → TERMINATED. Idempotent — duplicate
 * reports against an already-terminated session are a no-op.
 */
export class VoiceStrikeThresholdDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  strikes?: number;

  @IsOptional()
  @IsObject()
  detail?: Record<string, unknown>;
}

export class ConsentDto {
  /** Standard exam rules consent — agreement is mandatory. */
  @IsBoolean()
  @Equals(true)
  consentRules!: boolean;

  /** AI proctor consent — required for the AI screening pipeline. */
  @IsBoolean()
  @Equals(true)
  consentAiReview!: boolean;

  @IsOptional()
  @IsString()
  consentVersion?: string;
}

export class SavePracticalDto {
  @IsString()
  taskId!: string;

  @IsString()
  contentText!: string;

  @IsOptional()
  aiChatLog?: { role: 'user' | 'assistant'; text: string; ts: number }[];

  @IsInt()
  @Min(0)
  version!: number;
}

export class AskPracticalAiDto {
  @IsString()
  taskId!: string;

  @IsString()
  prompt!: string;

  @IsOptional()
  history?: { role: 'user' | 'assistant'; text: string }[];
}

import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

export class AiReviewRequestDto {
  /** base64-encoded JPEG (no `data:` prefix). The frontend captures 320×240. */
  @IsString()
  @Length(1, 6_000_000)
  imageBase64!: string;

  @IsString()
  @Length(1, 64)
  sessionId!: string;

  /** Client-supplied epoch ms — used for idempotency `(sessionId, ts)`. */
  @IsInt()
  @Min(0)
  ts!: number;

  /**
   * Optional: base64 JPEG (no `data:` prefix) of the candidate's most recent
   * screen-share thumbnail. When the AI confirms a violation, this frame is
   * persisted to NCP alongside the webcam frame so admins can see what was
   * on screen at the moment of the offense. Absent when the candidate has
   * not granted screen share, or before the first screen-thumb tick.
   */
  @IsOptional()
  @IsString()
  @Length(1, 6_000_000)
  screenImageBase64?: string;
}

export class DemoAiReviewDto {
  @IsString()
  @Length(1, 6_000_000)
  imageBase64!: string;

  @IsInt()
  @Min(0)
  ts!: number;
}

export class VoiceClipMetadataDto {
  @IsString()
  @Length(1, 64)
  sessionId!: string;

  @IsInt()
  @Min(0)
  ts!: number;

  @IsOptional()
  @IsNumber()
  @Min(-200)
  @Max(0)
  peakDb?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  durationMs?: number;
}

/**
 * Demo runs don't have an ExamSession row — sessionId is omitted and we
 * derive userId from the JWT instead. Used by /cbt/demo/proctor/voice-clip.
 */
export class DemoVoiceClipMetadataDto {
  @IsInt()
  @Min(0)
  ts!: number;

  @IsOptional()
  @IsNumber()
  @Min(-200)
  @Max(0)
  peakDb?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  durationMs?: number;
}

/**
 * Demo evidence upload (non-voice): a single base64 frame + kind tag.
 * Used by /cbt/demo/proctor/evidence so DemoPage can persist the
 * screenshot it already captures client-side for each violation.
 */
export class DemoEvidenceDto {
  @IsString()
  @Length(1, 6_000_000)
  imageBase64!: string;

  @IsInt()
  @Min(0)
  ts!: number;

  /**
   * Free-form short tag (LOOK_AWAY, NO_FACE, VOICE, PAGE_LEAVE, etc.) —
   * mirrors the kinds DemoPage already builds. Stored verbatim so the
   * MyPage timeline can show the same labels users see in the demo
   * result UI.
   */
  @IsString()
  @Length(1, 64)
  kind!: string;

  @IsOptional()
  @IsString()
  @Length(1, 16)
  severity?: string;
}

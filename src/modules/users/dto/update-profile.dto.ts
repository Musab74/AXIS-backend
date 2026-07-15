import { IsEmail, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Previously this route took an inline `{ email?: string }` structural type. A TS
 * interface erases at runtime, so the global ValidationPipe had no metadata to
 * work with and silently validated NOTHING on the one route that writes a UNIQUE
 * column — no format check, no length cap, and `whitelist` never stripped unknown
 * keys. This DTO closes that.
 *
 * Email is REQUIRED here: the route's only job is to set one, and permitting an
 * absent/empty value would let a caller no-op past the account email gate.
 */
export class UpdateProfileDto {
  @ApiProperty({ description: '이메일 주소', example: 'user@example.com' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  // 190, not 191: the column is a utf8mb4 UNIQUE index, and MySQL caps the key at
  // 191 chars. Rejecting here beats a P2002 from the database.
  @MaxLength(190, { message: '이메일이 너무 깁니다' })
  @IsEmail({}, { message: '이메일 형식이 올바르지 않습니다' })
  email!: string;
}

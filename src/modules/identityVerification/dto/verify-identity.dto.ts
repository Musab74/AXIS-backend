import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class VerifyIdentityDto {
  /**
   * Expected legal name to match against the OCR'd ID. If omitted, falls back
   * to the authenticated user's stored name.
   */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  expectedName?: string;

  /**
   * Expected date of birth in YYYY-MM-DD. Optional; if omitted, only the name
   * is checked. If provided, must match the OCR'd birthDate exactly.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'expectedBirthDate must be YYYY-MM-DD',
  })
  expectedBirthDate?: string;
}

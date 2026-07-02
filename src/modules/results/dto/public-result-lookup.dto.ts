import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Public (no-login) score lookup. Identity is proven with the registration
 * number plus two personal facts; anything less makes results guessable.
 */
export class PublicResultLookupDto {
  @IsString()
  @MinLength(6, { message: '접수번호를 입력하세요' })
  @MaxLength(40)
  registrationNumber!: string;

  @IsString()
  @MinLength(1, { message: '이름을 입력하세요' })
  @MaxLength(50)
  name!: string;

  /** Accepts 19900101, 1990-01-01, 1990.01.01 — normalized to digits server-side. */
  @IsString()
  @Matches(/^[0-9.\-/]{8,10}$/, { message: '생년월일 8자리를 입력하세요 (예: 19900101)' })
  birthDate!: string;
}

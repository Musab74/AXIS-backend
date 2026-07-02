import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CertType } from '@prisma/client';
import { PublicResultLookupDto } from './dto/public-result-lookup.dto';
import { ResultsService } from './results.service';

@ApiTags('Results (public)')
@Controller('results/public')
export class PublicResultsController {
  constructor(private readonly svc: ResultsService) {}

  @Get('rounds')
  @ApiOperation({ summary: '회차별 합격 발표 요약 (비로그인, 페이지네이션)' })
  listRounds(
    @Query('certType') certType?: string,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
  ) {
    const parsed = this.parseCertOptional(certType);
    const page = this.parsePositiveInt(pageRaw, 1, 1, 10_000);
    const pageSize = this.parsePositiveInt(pageSizeRaw, 10, 5, 50);
    return this.svc.listPublicRounds({ certType: parsed, page, pageSize });
  }

  // Tight per-IP throttle: identity facts are the only gate, so brute-forcing
  // name/birth-date combinations must be expensive.
  @Post('lookup')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: '접수번호 + 이름 + 생년월일로 본인 성적 조회 (비로그인)' })
  lookup(@Body() dto: PublicResultLookupDto) {
    return this.svc.publicLookup(dto);
  }

  @Get(':scheduleId')
  @ApiOperation({ summary: '회차별 합격자 목록 (비로그인, 발표 완료 회차만)' })
  passList(@Param('scheduleId') scheduleId: string) {
    return this.svc.getPublicPassList(scheduleId);
  }

  private parseCertOptional(raw?: string): CertType | undefined {
    if (raw == null || String(raw).trim() === '') return undefined;
    const normalized = String(raw).trim().toUpperCase().replace('-', '_');
    if (normalized === CertType.AXIS || normalized === CertType.AXIS_C || normalized === CertType.AXIS_H) {
      return normalized as CertType;
    }
    return undefined;
  }

  private parsePositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
    if (raw == null || String(raw).trim() === '') return fallback;
    const n = parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }
}

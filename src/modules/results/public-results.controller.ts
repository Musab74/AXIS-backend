import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CertType } from '@prisma/client';
import { PublicResultLookupDto } from './dto/public-result-lookup.dto';
import { PublicRoundStatusFilter, ResultsService } from './results.service';

@ApiTags('Results (public)')
@Controller('results/public')
export class PublicResultsController {
  constructor(private readonly svc: ResultsService) {}

  @Get('rounds')
  @ApiOperation({ summary: '회차별 합격 발표 요약 (비로그인, 상태·시험일 필터 + 페이지네이션)' })
  listRounds(
    @Query('certType') certType?: string,
    @Query('status') statusRaw?: string,
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
  ) {
    const parsed = this.parseCertOptional(certType);
    const status = this.parseStatusOptional(statusRaw);
    const examDateFrom = this.parseKstDateOptional(fromRaw, false);
    const examDateTo = this.parseKstDateOptional(toRaw, true);
    const page = this.parsePositiveInt(pageRaw, 1, 1, 10_000);
    const pageSize = this.parsePositiveInt(pageSizeRaw, 10, 5, 50);
    return this.svc.listPublicRounds({
      certType: parsed,
      status,
      examDateFrom,
      examDateTo,
      page,
      pageSize,
    });
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

  private parseStatusOptional(raw?: string): PublicRoundStatusFilter | undefined {
    if (raw == null || String(raw).trim() === '') return undefined;
    const normalized = String(raw).trim().toLowerCase();
    // "passed" is accepted as an alias for the announced (발표 완료) state.
    if (normalized === 'passed' || normalized === 'announced') return 'announced';
    if (normalized === 'grading') return 'grading';
    if (normalized === 'upcoming') return 'upcoming';
    return undefined;
  }

  /** YYYY-MM-DD interpreted as a KST calendar day. */
  private parseKstDateOptional(raw: string | undefined, endOfDay: boolean): Date | undefined {
    if (raw == null || String(raw).trim() === '') return undefined;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw).trim());
    if (!m) return undefined;
    const time = endOfDay ? '23:59:59.999' : '00:00:00.000';
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${time}+09:00`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  private parsePositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
    if (raw == null || String(raw).trim() === '') return fallback;
    const n = parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }
}

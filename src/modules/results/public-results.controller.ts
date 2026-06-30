import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CertType } from '@prisma/client';
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

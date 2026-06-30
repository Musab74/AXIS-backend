import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CertType } from '@prisma/client';
import { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { AdminReportsService, GeneratedFile, ReportFilter } from './admin-reports.service';

type RawQuery = {
  certType?: string;
  level?: string;
  round?: string; // "<year>-<roundNumber>"
  year?: string;
  roundNumber?: string;
  from?: string;
  to?: string;
  fields?: string;
};

@ApiTags('admin-reports')
@ApiBearerAuth()
@Controller('admin/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'EXAM_ADMIN', 'GRADING_ADMIN')
export class AdminReportsController {
  constructor(private readonly svc: AdminReportsService) {}

  @Get('rounds')
  @ApiOperation({ summary: 'Distinct rounds for report dropdowns' })
  rounds() {
    return this.svc.rounds();
  }

  @Get('pass-list')
  @ApiOperation({ summary: 'Pass list (Excel)' })
  async passList(@Query() q: RawQuery, @Res() res: Response) {
    this.send(res, await this.svc.passList(this.toFilter(q)));
  }

  @Get('grading-status')
  @ApiOperation({ summary: 'Grading status (Excel)' })
  async gradingStatus(@Query() q: RawQuery, @Res() res: Response) {
    this.send(res, await this.svc.gradingStatus(this.toFilter(q)));
  }

  @Get('item-analysis')
  @ApiOperation({ summary: 'Item analysis (Excel)' })
  async itemAnalysis(@Query() q: RawQuery, @Res() res: Response) {
    this.send(res, await this.svc.itemAnalysis(this.toFilter(q)));
  }

  @Get('custom')
  @ApiOperation({ summary: 'Custom field-driven export (Excel)' })
  async custom(@Query() q: RawQuery, @Res() res: Response) {
    const fields = (q.fields ?? '')
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    this.send(res, await this.svc.custom(this.toFilter(q), fields));
  }

  @Get('round-comprehensive')
  @ApiOperation({ summary: 'Round comprehensive report (PDF)' })
  async roundComprehensive(@Query() q: RawQuery, @Res() res: Response) {
    this.send(res, await this.svc.roundComprehensive(this.toFilter(q)));
  }

  // ──────────────────────────────────────────────────────────
  private toFilter(q: RawQuery): ReportFilter {
    let year: number | undefined;
    let roundNumber: number | undefined;
    if (q.round && /^\d+-\d+$/.test(q.round)) {
      const [y, r] = q.round.split('-');
      year = Number(y);
      roundNumber = Number(r);
    }
    if (q.year) year = Number(q.year);
    if (q.roundNumber) roundNumber = Number(q.roundNumber);

    const certType =
      q.certType && q.certType !== 'all' && q.certType in CertType
        ? (q.certType as CertType)
        : undefined;
    const level =
      q.level === 'L1' || q.level === 'L2' || q.level === 'L3' ? q.level : undefined;

    return { certType, level, year, roundNumber, from: q.from, to: q.to };
  }

  private send(res: Response, file: GeneratedFile) {
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Content-Length', file.buffer.length);
    res.end(file.buffer);
  }
}

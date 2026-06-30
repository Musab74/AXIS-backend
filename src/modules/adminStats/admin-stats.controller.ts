import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { AdminStatsService } from './admin-stats.service';
import { StatsFilterDto } from './dto/stats-query.dto';

@ApiTags('admin-stats')
@ApiBearerAuth()
@Controller('admin/stats')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'EXAM_ADMIN', 'GRADING_ADMIN')
export class AdminStatsController {
  constructor(private readonly svc: AdminStatsService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Top-level admin KPIs' })
  dashboard() {
    return this.svc.dashboard();
  }

  @Get('pass-rate')
  @ApiOperation({ summary: 'Pass-rate trend, distribution, by-cert' })
  passRate(@Query() q: StatsFilterDto) {
    return this.svc.passRate(q);
  }

  @Get('subjects')
  @ApiOperation({ summary: 'Subject averages, heatmap, practical, AI vs expert' })
  subjects(@Query() q: StatsFilterDto) {
    return this.svc.subjects(q);
  }
}

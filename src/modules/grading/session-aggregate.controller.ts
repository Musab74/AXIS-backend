import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { SessionAggregateService } from './session-aggregate.service';

/**
 * v2.0 (WP7) admin/export access to the per-examinee session-aggregate record
 * (AXIS_L*_채점_세션집계_JSON스키마_v1_0.json). The record contains only
 * de-identified refs (applicant_ref hash) but score data is still exam-ops
 * material — admin/expert only.
 */
@ApiTags('admin-session-aggregate')
@ApiBearerAuth()
@Controller('admin/sessions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'GRADING_ADMIN', 'EXAM_ADMIN', 'EXPERT')
export class SessionAggregateController {
  constructor(private readonly svc: SessionAggregateService) {}

  @Get(':id/aggregate')
  @ApiOperation({ summary: 'Session-aggregate record (v2.0 schema-shaped JSON + validation state)' })
  get(@Param('id') sessionId: string) {
    return this.svc.get(sessionId);
  }

  /** Manual rebuild — e.g. after an out-of-band score correction. */
  @Post(':id/aggregate/rebuild')
  @Roles('SUPER_ADMIN', 'GRADING_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: 'Rebuild the session-aggregate record from current scores' })
  rebuild(@Param('id') sessionId: string) {
    return this.svc.rebuild(sessionId);
  }
}

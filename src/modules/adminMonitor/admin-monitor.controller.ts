import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { AdminMonitorActionsService } from './admin-monitor-actions.service';
import {
  MonitorExtendDto,
  MonitorPauseDto,
  MonitorTerminateDto,
  MonitorWarnDto,
} from './admin-monitor.dto';
import { AdminMonitorService } from './admin-monitor.service';

@ApiTags('admin-monitor')
@ApiBearerAuth()
@Controller('admin/monitor')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminMonitorController {
  constructor(
    private readonly svc: AdminMonitorService,
    private readonly actions: AdminMonitorActionsService,
  ) {}

  @Get('live')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN', 'GRADING_ADMIN', 'PROCTOR', 'EXPERT')
  @ApiOperation({ summary: 'Live exam sessions list' })
  live() {
    return this.svc.listLive();
  }

  @Get('summary')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN', 'GRADING_ADMIN', 'PROCTOR', 'EXPERT')
  @ApiOperation({ summary: 'Top-bar live exam summary' })
  summary() {
    return this.svc.summary();
  }

  @Get('sessions/:id')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN', 'GRADING_ADMIN', 'PROCTOR', 'EXPERT')
  @ApiOperation({ summary: 'Per-session live detail' })
  detail(@Param('id') id: string) {
    return this.svc.getDetail(id);
  }

  @Post('sessions/:id/warn')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN', 'PROCTOR')
  @ApiOperation({ summary: 'Push manual warning to candidate' })
  warn(
    @CurrentUser('id') actorId: string,
    @Param('id') sessionId: string,
    @Body() dto: MonitorWarnDto,
  ) {
    return this.actions.warn(actorId, sessionId, dto.message);
  }

  @Post('sessions/:id/pause')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: 'Toggle exam timer pause/resume' })
  pause(
    @CurrentUser('id') actorId: string,
    @Param('id') sessionId: string,
    @Body() dto: MonitorPauseDto,
  ) {
    return this.actions.togglePause(actorId, sessionId, dto.reason);
  }

  @Post('sessions/:id/extend')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: 'Extend exam hard deadline' })
  extend(
    @CurrentUser('id') actorId: string,
    @Param('id') sessionId: string,
    @Body() dto: MonitorExtendDto,
  ) {
    return this.actions.extend(actorId, sessionId, dto.seconds);
  }

  @Post('sessions/:id/terminate')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN', 'PROCTOR')
  @ApiOperation({ summary: 'Force-terminate an in-progress exam session' })
  terminate(
    @CurrentUser('id') actorId: string,
    @Param('id') sessionId: string,
    @Body() dto: MonitorTerminateDto,
  ) {
    return this.actions.terminate(actorId, sessionId, dto.reason);
  }
}

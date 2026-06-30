import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CertLevel, CertType, ScheduleStatus } from '@prisma/client';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { CreateOnDemandScheduleDto, SchedulesService } from './schedules.service';

function parseCertQuery(cert: string | undefined): CertType {
  if (!cert) {
    throw new BadRequestException('cert is required');
  }
  const normalized = cert.trim().toUpperCase().replace('-', '_');
  if (normalized === CertType.AXIS || normalized === CertType.AXIS_C || normalized === CertType.AXIS_H) {
    return normalized as CertType;
  }
  throw new BadRequestException('cert must be one of AXIS, AXIS-C, AXIS-H');
}

@ApiTags('Schedules')
@Controller('schedules')
export class SchedulesController {
  constructor(private readonly svc: SchedulesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'List exam schedules' })
  list(
    @Query('certType') certType?: CertType,
    @Query('level') level?: CertLevel,
    @Query('status') status?: ScheduleStatus,
    @Query('upcomingOnly') upcomingOnly?: string,
  ) {
    return this.svc.list({
      certType,
      level,
      status,
      upcomingOnly: upcomingOnly === 'true' || upcomingOnly === '1',
    });
  }

  @Public()
  @Get('available')
  @ApiOperation({ summary: 'List open schedules with real-time remaining seats' })
  available(
    @Query('certType') certType?: CertType,
    @Query('level') level?: CertLevel,
  ) {
    return this.svc.getAvailable(certType, level);
  }

  @Public()
  @Get('slots')
  @ApiOperation({ summary: 'On-demand time slots (L1/L2/L3) for a specific date' })
  slots(
    @Query('certType') certType?: CertType,
    @Query('date') date?: string,
    @Query('level') level?: CertLevel,
  ) {
    if (!certType) throw new BadRequestException('certType is required');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }
    return this.svc.getSlots(certType, date, level ?? CertLevel.L3);
  }

  @Public()
  @Get('calendar')
  @ApiOperation({ summary: 'Monthly exam calendar' })
  calendar(
    @Query('year') year?: string,
    @Query('month') month?: string,
    @Query('certType') certType?: CertType,
    @Query('level') level?: CertLevel,
  ) {
    const y = year ? parseInt(year, 10) : new Date().getFullYear();
    const m = month ? parseInt(month, 10) : new Date().getMonth() + 1;
    if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
      throw new BadRequestException('Invalid year or month');
    }
    return this.svc.getCalendar(y, m, certType, level);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Get a single schedule' })
  get(@Param('id') id: string) {
    return this.svc.getById(id);
  }

  /**
   * Create an on-demand exam schedule for any date/time.
   * Online exams can be scheduled flexibly — no fixed time slots.
   */
  @Post('on-demand')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create on-demand schedule for any date/time (online exams)' })
  createOnDemand(@Body() dto: CreateOnDemandScheduleDto) {
    if (!dto.certType) throw new BadRequestException('certType is required');
    if (!dto.level) throw new BadRequestException('level is required');
    if (!dto.examDate) throw new BadRequestException('examDate is required');
    return this.svc.createOnDemand(dto);
  }

  /**
   * Find or create a schedule for the requested date/time.
   * Useful for self-service exam booking — creates schedule if none exists.
   */
  @Post('find-or-create')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Find existing or create new schedule for date/time' })
  findOrCreate(@Body() dto: CreateOnDemandScheduleDto) {
    if (!dto.certType) throw new BadRequestException('certType is required');
    if (!dto.level) throw new BadRequestException('level is required');
    if (!dto.examDate) throw new BadRequestException('examDate is required');
    return this.svc.findOrCreateOnDemand(dto);
  }
}

@ApiTags('Schedule API')
@Controller('schedule')
export class ScheduleApiController {
  constructor(private readonly svc: SchedulesService) {}

  @Public()
  @Get('slots')
  @ApiOperation({ summary: 'Hybrid model L3 slots API (/schedule/slots?cert=&date=)' })
  slots(
    @Query('cert') cert?: string,
    @Query('date') date?: string,
  ) {
    const certType = parseCertQuery(cert);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }
    return this.svc.getSlots(certType, date, CertLevel.L3, 60);
  }
}

@ApiTags('admin-schedules')
@ApiBearerAuth()
@Controller('admin/schedules')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminSchedulesController {
  constructor(private readonly svc: SchedulesService) {}

  @Get('registrations')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: '관리자: 등록된 시험 목록 조회(응시자 정보 포함)' })
  listRegistrations(
    @Query('certType') certType?: CertType,
    @Query('level') level?: CertLevel,
    @Query('scheduleStatus') scheduleStatus?: ScheduleStatus,
  ) {
    return this.svc.listRegisteredExams({
      certType,
      level,
      scheduleStatus,
    });
  }
}

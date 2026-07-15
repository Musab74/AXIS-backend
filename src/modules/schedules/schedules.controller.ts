import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CertLevel, CertType, ScheduleStatus } from '@prisma/client';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import {
  CreateAdminScheduleDto,
  CreateOnDemandScheduleDto,
  SchedulesService,
  UpdateAdminScheduleDto,
} from './schedules.service';

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

/** Optional list filters — invalid values must 400, never reach Prisma (500). */
function parseOptionalCertType(raw?: string): CertType | undefined {
  if (raw == null || raw === '') return undefined;
  const normalized = raw.trim().toUpperCase().replace('-', '_');
  if (normalized === CertType.AXIS || normalized === CertType.AXIS_C || normalized === CertType.AXIS_H) {
    return normalized as CertType;
  }
  throw new BadRequestException('certType must be one of AXIS, AXIS_C, AXIS_H');
}

function parseOptionalCertLevel(raw?: string): CertLevel | undefined {
  if (raw == null || raw === '') return undefined;
  const normalized = raw.trim().toUpperCase();
  if (normalized === CertLevel.L1 || normalized === CertLevel.L2 || normalized === CertLevel.L3) {
    return normalized as CertLevel;
  }
  throw new BadRequestException('level must be one of L1, L2, L3');
}

function parseOptionalScheduleStatus(raw?: string): ScheduleStatus | undefined {
  if (raw == null || raw === '') return undefined;
  const normalized = raw.trim().toUpperCase();
  const allowed = Object.values(ScheduleStatus) as string[];
  if (allowed.includes(normalized)) return normalized as ScheduleStatus;
  throw new BadRequestException(`status must be one of ${allowed.join(', ')}`);
}

@ApiTags('Schedules')
@Controller('schedules')
export class SchedulesController {
  constructor(private readonly svc: SchedulesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'List exam schedules' })
  list(
    @Query('certType') certType?: string,
    @Query('level') level?: string,
    @Query('status') status?: string,
    @Query('upcomingOnly') upcomingOnly?: string,
  ) {
    return this.svc.list({
      certType: parseOptionalCertType(certType),
      level: parseOptionalCertLevel(level),
      status: parseOptionalScheduleStatus(status),
      upcomingOnly: upcomingOnly === 'true' || upcomingOnly === '1',
    });
  }

  @Public()
  @Get('available')
  @ApiOperation({ summary: 'List open schedules with real-time remaining seats' })
  available(
    @Query('certType') certType?: string,
    @Query('level') level?: string,
  ) {
    return this.svc.getAvailable(parseOptionalCertType(certType), parseOptionalCertLevel(level));
  }

  @Public()
  @Get('slots')
  @ApiOperation({ summary: 'On-demand time slots (L1/L2/L3) for a specific date' })
  slots(
    @Query('certType') certType?: string,
    @Query('date') date?: string,
    @Query('level') level?: string,
  ) {
    const parsedCert = parseOptionalCertType(certType);
    if (!parsedCert) throw new BadRequestException('certType is required');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }
    return this.svc.getSlots(parsedCert, date, parseOptionalCertLevel(level) ?? CertLevel.L3);
  }

  @Public()
  @Get('calendar')
  @ApiOperation({ summary: 'Monthly exam calendar' })
  calendar(
    @Query('year') year?: string,
    @Query('month') month?: string,
    @Query('certType') certType?: string,
    @Query('level') level?: string,
  ) {
    const y = year ? parseInt(year, 10) : new Date().getFullYear();
    const m = month ? parseInt(month, 10) : new Date().getMonth() + 1;
    if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
      throw new BadRequestException('Invalid year or month');
    }
    return this.svc.getCalendar(y, m, parseOptionalCertType(certType), parseOptionalCertLevel(level));
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

  @Get('on-demand-settings')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: '관리자: L3/온디맨드 슬롯 기본 설정 조회' })
  getOnDemandSettings() {
    return this.svc.getOnDemandSettings();
  }

  @Patch('on-demand-settings')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: '관리자: L3/온디맨드 슬롯 기본 설정 수정' })
  updateOnDemandSettings(
    @Body()
    body: {
      businessHoursStart?: number;
      businessHoursEnd?: number;
      defaultSlotCapacity?: number;
      slotUnitMinutes?: number;
    },
  ) {
    return this.svc.updateOnDemandSettings(body);
  }

  @Post()
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: '관리자: 새 시험 회차 등록 (자격·등급·일시·접수기간)' })
  create(@Body() dto: CreateAdminScheduleDto) {
    return this.svc.createAdmin(dto);
  }

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

  @Patch(':id')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: '관리자: 시험 회차 수정' })
  update(@Param('id') id: string, @Body() dto: UpdateAdminScheduleDto) {
    return this.svc.updateAdmin(id, dto);
  }
}

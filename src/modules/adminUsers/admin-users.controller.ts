import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { AuthenticatedUser } from '../../common/types/authenticated-user';
import { AdminUsersService } from './admin-users.service';
import { SearchUsersDto } from './dto/search-users.dto';
import { SearchExamineesDto } from './dto/search-examinees.dto';
import { RevealPiiDto } from './dto/reveal-pii.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { IssuePenaltyDto } from './dto/issue-penalty.dto';
import { ReleasePenaltyDto } from './dto/release-penalty.dto';
import { CreateExpertDto } from './dto/create-expert.dto';
import {
  ExamineeDetail,
  ExamineeListResult,
  ExpertSummary,
  IssuedPenalty,
  MemberProfile,
  SearchUsersResult,
  UserActivity,
  UserDetail,
} from './admin-users.types';

@ApiTags('admin-users')
@ApiBearerAuth()
@Controller('admin/users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Get()
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: '관리자: 사용자 검색' })
  searchUsers(@Query() dto: SearchUsersDto): Promise<SearchUsersResult> {
    return this.adminUsersService.searchUsers(dto);
  }

  @Get('export')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: '관리자: 회원 목록 Excel 다운로드' })
  async exportUsers(@Query() dto: SearchUsersDto, @Res() res: Response): Promise<void> {
    const file = await this.adminUsersService.exportUsers(dto);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Content-Length', file.buffer.length);
    res.end(file.buffer);
  }

  @Get('experts')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN', 'GRADING_ADMIN')
  @ApiOperation({ summary: '관리자: 채점위원(EXPERT) 목록' })
  listExperts(): Promise<ExpertSummary[]> {
    return this.adminUsersService.listExperts();
  }

  @Post('experts')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: '관리자: 채점위원(EXPERT) 계정 생성' })
  createExpert(
    @Req() req: Request,
    @Body() dto: CreateExpertDto,
  ): Promise<ExpertSummary> {
    const actor = req.user as AuthenticatedUser;
    return this.adminUsersService.createExpert(actor, dto, this.extractIp(req));
  }

  @Get(':id/activity')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: '관리자: 회원 활동 로그 (로그인 IP, 동의 IP)' })
  getUserActivity(@Param('id') targetId: string): Promise<UserActivity> {
    return this.adminUsersService.getUserActivity(targetId);
  }

  @Get(':id/member-profile')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: '관리자: 회원 360° 프로필 (시험·응시·제재 통합)' })
  getMemberProfile(@Param('id') targetId: string): Promise<MemberProfile> {
    return this.adminUsersService.getMemberProfile(targetId);
  }

  @Get(':id')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: '관리자: 사용자 상세 조회' })
  getUserDetail(@Param('id') targetId: string): Promise<UserDetail> {
    return this.adminUsersService.getUserDetail(targetId);
  }

  @Post(':id/reset-password')
  @Roles('SUPER_ADMIN')
  @ApiOperation({
    summary: '관리자: 비밀번호 초기화 (고정 임시 비밀번호 + 다음 로그인 시 변경 강제)',
  })
  resetPassword(
    @Req() req: Request,
    @Param('id') targetId: string,
  ): Promise<{ ok: true; tempPassword: string }> {
    const actor = req.user as AuthenticatedUser;
    return this.adminUsersService.resetPassword(actor, targetId, this.extractIp(req));
  }

  @Post(':id/pii-reveal')
  @Roles('SUPER_ADMIN')
  @ApiOperation({
    summary: '관리자: 마스킹된 연락처/생년월일 열람 (사유 필수, 감사 로그 저장)',
  })
  revealPii(
    @Req() req: Request,
    @Param('id') targetId: string,
    @Body() dto: RevealPiiDto,
  ): Promise<{ phone: string; birthDate: string | null }> {
    const actor = req.user as AuthenticatedUser;
    return this.adminUsersService.revealPii(actor, targetId, dto.reason, this.extractIp(req));
  }

  @Patch(':id/roles')
  @Roles('SUPER_ADMIN')
  @ApiOperation({ summary: '관리자: 권한 부여/회수' })
  async updateRole(
    @Req() req: Request,
    @Param('id') targetId: string,
    @Body() dto: UpdateRoleDto,
  ): Promise<{ message: string }> {
    const actor = req.user as AuthenticatedUser;
    const ip = this.extractIp(req);
    await this.adminUsersService.updateRole(actor, targetId, dto, ip);
    return { message: dto.grant ? '권한이 부여되었습니다' : '권한이 회수되었습니다' };
  }

  @Post(':id/penalties')
  @Roles('SUPER_ADMIN')
  @ApiOperation({ summary: '관리자: 제재 부과' })
  issuePenalty(
    @Req() req: Request,
    @Param('id') targetId: string,
    @Body() dto: IssuePenaltyDto,
  ): Promise<IssuedPenalty> {
    const actor = req.user as AuthenticatedUser;
    const ip = this.extractIp(req);
    return this.adminUsersService.issuePenalty(actor, targetId, dto, ip);
  }

  @Patch('experts/:id/competencies')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: '관리자: 채점위원 시리즈 자격 설정 (전체 교체)' })
  async updateExpertCompetencies(
    @Req() req: Request,
    @Param('id') targetId: string,
    @Body() body: { competencies: string[] },
  ): Promise<ExpertSummary> {
    const actor = req.user as AuthenticatedUser;
    return this.adminUsersService.updateExpertCompetencies(actor, targetId, body.competencies ?? []);
  }

  @Patch(':id/penalties/:penaltyId/release')
  @Roles('SUPER_ADMIN')
  @ApiOperation({ summary: '관리자: 제재 조기 해제' })
  async releasePenalty(
    @Req() req: Request,
    @Param('id') targetId: string,
    @Param('penaltyId') penaltyId: string,
    @Body() body: ReleasePenaltyDto,
  ): Promise<{ message: string }> {
    const actor = req.user as AuthenticatedUser;
    const ip = this.extractIp(req);
    await this.adminUsersService.releasePenalty(
      actor,
      targetId,
      penaltyId,
      body.releaseReason,
      ip,
    );
    return { message: '제재가 해제되었습니다' };
  }

  private extractIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    const headerValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const fromHeader = headerValue?.split(',')[0]?.trim();
    return fromHeader ?? req.ip ?? 'unknown';
  }
}

@ApiTags('admin-examinees')
@ApiBearerAuth()
@Controller('admin/examinees')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminExamineesController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Get()
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({
    summary: '관리자: 응시자 목록 (등록 + 세션 + 자격증 상태 통합)',
  })
  list(@Query() dto: SearchExamineesDto): Promise<ExamineeListResult> {
    return this.adminUsersService.listExaminees(dto);
  }

  @Get('export')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: '관리자: 접수·결제 목록 Excel 다운로드' })
  async export(@Query() dto: SearchExamineesDto, @Res() res: Response): Promise<void> {
    const file = await this.adminUsersService.exportExaminees(dto);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Content-Length', file.buffer.length);
    res.end(file.buffer);
  }

  @Get(':userId')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({
    summary: '관리자: 응시자 상세 (등록/세션/자격증/제재 일괄 조회)',
  })
  detail(@Param('userId') userId: string): Promise<ExamineeDetail> {
    return this.adminUsersService.getExamineeDetail(userId);
  }
}

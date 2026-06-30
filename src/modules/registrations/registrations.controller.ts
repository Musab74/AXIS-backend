import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { CertLevel, CertType } from '@prisma/client';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/types/authenticated-user';
import { NcObjectStorageService } from '../../integrations/ncObjectStorage/nc-object-storage.service';
import { PrismaService } from '../../common/prisma.service';
import { RegistrationsService, normalizeEligibilityType } from './registrations.service';
import { AdminRefundDto } from './dto/admin-refund.dto';
import { GrantAttemptDto } from './dto/grant-attempt.dto';

class CreateRegistrationDto {
  @IsString()
  scheduleId!: string;
}

class QuickBookDto {
  @IsEnum(CertType)
  certType!: CertType;

  @IsEnum(CertLevel)
  level!: CertLevel;

  @IsOptional()
  @IsString()
  examDate?: string;
}

class CancelRegistrationDto {
  reason?: string;
}

@ApiTags('Registrations')
@Controller('registrations')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class RegistrationsController {
  constructor(
    private readonly svc: RegistrationsService,
    private readonly ncp: NcObjectStorageService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('mine')
  @ApiOperation({ summary: 'List my registrations' })
  mine(@CurrentUser('id') userId: string) {
    return this.svc.listMine(userId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a registration (holds seat 30 min)' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateRegistrationDto) {
    return this.svc.create(userId, dto.scheduleId);
  }

  @Post('quick-book')
  @ApiOperation({ summary: 'Quick book: Create schedule + registration for any date/time (online exams)' })
  quickBook(@CurrentUser('id') userId: string, @Body() dto: QuickBookDto) {
    return this.svc.quickBook(userId, dto);
  }

  @Get(':id/ticket')
  @ApiOperation({ summary: 'Get exam voucher for a paid registration' })
  ticket(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.svc.getTicket(userId, id);
  }

  @Post('document')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload L1 eligibility document (PDF or image)' })
  async uploadDocument(
    @CurrentUser('id') userId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('registrationId') registrationId: string,
    @Body('eligibilityType') eligibilityType: string | undefined,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!registrationId) throw new BadRequestException('registrationId is required');

    const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException('Only PDF, JPEG, or PNG files are accepted');
    }
    if (file.size > 10 * 1024 * 1024) {
      throw new BadRequestException('File must be under 10 MB');
    }

    // Verify the registration belongs to this user
    const reg = await this.prisma.registration.findUnique({
      where: { id: registrationId },
    });
    if (!reg) throw new BadRequestException('Registration not found');
    if (reg.userId !== userId) throw new BadRequestException('Not your registration');

    const ext = file.originalname.split('.').pop() ?? 'bin';
    const key = `docs/${userId}/${registrationId}/${Date.now()}.${ext}`;

    await this.ncp.put('axis-docs', key, file.buffer, file.mimetype, 365 * 3);

    // Persist docUrl + declared eligibility basis. Only AXIS-C L1 requires admin
    // review — move it to PENDING so the real exam stays locked until approved.
    // AXIS L1 and AXIS-H L1 never need a document, so they keep NOT_REQUIRED
    // and no review state is set even if a file is uploaded here.
    const docUrl = `${key}`;
    const normalizedType = normalizeEligibilityType(eligibilityType ?? reg.eligibilityType);
    await this.prisma.registration.update({
      where: { id: registrationId },
      data: {
        supportDocUrl: docUrl,
        ...(reg.certType === 'AXIS_C' && reg.level === 'L1'
          ? {
              eligibilityType: normalizedType ?? reg.eligibilityType ?? null,
              eligibilityStatus: 'PENDING',
              eligibilityReviewedBy: null,
              eligibilityReviewedAt: null,
            }
          : {}),
      },
    });

    return { docUrl };
  }

  @Patch(':id/eligibility-basis')
  @ApiOperation({ summary: 'Set L1 eligibility basis (AXIS-C L1 apply wizard)' })
  setEligibilityBasis(
    @CurrentUser('id') userId: string,
    @Param('id') registrationId: string,
    @Body('eligibilityType') eligibilityType: string,
  ) {
    return this.svc.setEligibilityBasis(userId, registrationId, eligibilityType);
  }

  @Post(':id/eligibility-refund')
  @ApiOperation({
    summary: 'Request 100% eligibility refund (AXIS-C L1) — admin approval required',
  })
  eligibilityRefund(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() body: { note?: string },
  ) {
    return this.svc.requestEligibilityRefund(userId, id, body?.note);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancel a registration (with tiered refund if already paid)' })
  cancel(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: CancelRegistrationDto,
  ) {
    return this.svc.cancelWithRefund(userId, id, dto.reason);
  }
}

@ApiTags('admin-registrations')
@ApiBearerAuth()
@Controller('admin/registrations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminRegistrationsController {
  constructor(private readonly svc: RegistrationsService) {}

  @Post(':id/refund')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({
    summary:
      '관리자 환불 처리 (TIERED: 정책 환불 / FULL: 100% 관리자 환불). 응시한 시험은 환불 불가.',
  })
  refund(
    @Req() req: Request,
    @Param('id') registrationId: string,
    @Body() dto: AdminRefundDto,
  ) {
    const actor = req.user as AuthenticatedUser;
    return this.svc.adminRefund(registrationId, dto, {
      id: actor.id,
      name: actor.name,
    });
  }

  @Post(':id/grant-attempt')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: '관리자: 응시 1회 추가 부여 (최대 2회)' })
  grantAttempt(
    @Req() req: Request,
    @Param('id') registrationId: string,
    @Body() dto: GrantAttemptDto,
  ) {
    const actor = req.user as AuthenticatedUser;
    return this.svc.grantAttempt(registrationId, { id: actor.id, name: actor.name }, dto.reason);
  }

  // ─── L1 eligibility review ─────────────────────────────────────────────
  @Get('eligibility')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN', 'GRADING_ADMIN', 'EXPERT')
  @ApiOperation({ summary: 'L1 eligibility review queue' })
  eligibilityQueue(@Query('status') status?: 'PENDING' | 'APPROVED' | 'REJECTED') {
    return this.svc.listEligibilityQueue(status);
  }

  @Get('eligibility/counts')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN', 'GRADING_ADMIN', 'EXPERT')
  @ApiOperation({ summary: 'Pending L1 eligibility document count' })
  eligibilityCounts() {
    return this.svc.countEligibilityPending();
  }

  @Get('eligibility/:id/document')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN', 'GRADING_ADMIN', 'EXPERT')
  @ApiOperation({ summary: 'Signed URL to view an L1 eligibility document' })
  eligibilityDoc(@Param('id') registrationId: string) {
    return this.svc.getEligibilityDocUrl(registrationId);
  }

  @Post('eligibility/:id/review')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN', 'GRADING_ADMIN', 'EXPERT')
  @ApiOperation({ summary: 'Approve or reject an L1 eligibility document' })
  reviewEligibility(
    @Req() req: Request,
    @Param('id') registrationId: string,
    @Body() body: { decision: 'APPROVED' | 'REJECTED'; note?: string },
  ) {
    const actor = req.user as AuthenticatedUser;
    return this.svc.reviewEligibility(actor.id, registrationId, body.decision, body.note);
  }

  // ─── L1 eligibility refund requests (candidate → admin approve) ────────
  @Get('eligibility-refunds')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: 'Eligibility 100% refund request queue' })
  eligibilityRefundQueue(@Query('status') status?: 'PENDING' | 'ALL') {
    return this.svc.listEligibilityRefundRequests(status ?? 'PENDING');
  }

  @Get('eligibility-refunds/counts')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: 'Pending eligibility refund request count' })
  eligibilityRefundCounts() {
    return this.svc.countEligibilityRefundPending();
  }

  @Post('eligibility-refunds/:id/approve')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: 'Approve eligibility refund request and execute 100% refund' })
  approveEligibilityRefund(
    @Req() req: Request,
    @Param('id') registrationId: string,
    @Body() body: { note?: string },
  ) {
    const actor = req.user as AuthenticatedUser;
    return this.svc.approveEligibilityRefundRequest(actor.id, registrationId, body?.note);
  }

  @Post('eligibility-refunds/:id/reject')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: 'Reject eligibility refund request (no payment action)' })
  rejectEligibilityRefund(
    @Req() req: Request,
    @Param('id') registrationId: string,
    @Body() body: { note?: string },
  ) {
    const actor = req.user as AuthenticatedUser;
    return this.svc.rejectEligibilityRefundRequest(actor.id, registrationId, body?.note);
  }
}

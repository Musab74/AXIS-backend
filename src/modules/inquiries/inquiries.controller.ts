import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { InquiryCategory, InquiryStatus } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { InquiriesService } from './inquiries.service';
import { CreateInquiryDto, CreateReplyDto } from './dto/create-inquiry.dto';
import { InquiryGateway } from './inquiry.gateway';
import { AdminNotificationsService } from '../adminNotifications/admin-notifications.service';

@Controller('inquiries')
@UseGuards(JwtAuthGuard)
export class InquiriesController {
  constructor(
    private readonly inquiriesService: InquiriesService,
    private readonly inquiryGateway: InquiryGateway,
    private readonly notifications: AdminNotificationsService,
  ) {}

  @Post()
  async createInquiry(@Request() req: any, @Body() dto: CreateInquiryDto) {
    const inquiry = await this.inquiriesService.createInquiry(req.user.id, dto);
    this.inquiryGateway.notifyNewInquiry(inquiry);
    void this.notifications.notify({
      category: 'INQUIRY',
      titleKo: '새 1:1 문의',
      titleEn: 'New inquiry',
      bodyKo: `${inquiry.user?.name ?? '응시자'} — ${inquiry.title}`,
      bodyEn: `${inquiry.user?.name ?? 'Candidate'} — ${inquiry.title}`,
      severity: 'INFO',
      href: '/qna',
      meta: { inquiryId: inquiry.id, category: inquiry.category },
    });
    return inquiry;
  }

  @Get('my')
  async getMyInquiries(
    @Request() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.inquiriesService.getUserInquiries(
      req.user.id,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 10,
    );
  }

  @Get(':id')
  async getInquiry(@Request() req: any, @Param('id') id: string) {
    return this.inquiriesService.getInquiryById(id, req.user.id);
  }

  @Post(':id/replies')
  async addReply(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: CreateReplyDto,
  ) {
    const reply = await this.inquiriesService.addReply(id, req.user.id, dto, false);
    const inquiry = await this.inquiriesService.getInquiryById(id);
    this.inquiryGateway.notifyNewReply(inquiry, reply, false);
    void this.notifications.notify({
      category: 'INQUIRY_REPLY',
      titleKo: '문의 답변 (응시자)',
      titleEn: 'Inquiry reply (candidate)',
      bodyKo: `${inquiry.user?.name ?? '응시자'} — ${inquiry.title}`,
      bodyEn: `${inquiry.user?.name ?? 'Candidate'} — ${inquiry.title}`,
      severity: 'INFO',
      href: '/qna',
      meta: { inquiryId: inquiry.id, replyId: reply.id },
    });
    return reply;
  }
}

@Controller('admin/inquiries')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'EXAM_ADMIN')
export class AdminInquiriesController {
  constructor(
    private readonly inquiriesService: InquiriesService,
    private readonly inquiryGateway: InquiryGateway,
  ) {}

  @Get('stats')
  async getStats() {
    return this.inquiriesService.getInquiryStats();
  }

  @Get()
  async getInquiries(
    @Query('status') status?: InquiryStatus,
    @Query('category') category?: InquiryCategory,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.inquiriesService.getAllInquiries({
      status,
      category,
      search,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  @Get(':id')
  async getInquiry(@Param('id') id: string) {
    return this.inquiriesService.getInquiryById(id);
  }

  @Post(':id/replies')
  async addReply(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: CreateReplyDto,
  ) {
    const reply = await this.inquiriesService.addReply(id, req.user.id, dto, true);
    const inquiry = await this.inquiriesService.getInquiryById(id);
    this.inquiryGateway.notifyNewReply(inquiry, reply, true);
    return reply;
  }

  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body('status') status: InquiryStatus,
  ) {
    const updated = await this.inquiriesService.updateStatus(id, status);
    // Notify both the inquiry room (any admin currently viewing it) and the
    // owning user so the badge/banner refreshes without a manual reload.
    this.inquiryGateway.notifyStatusChange(updated.id, updated.status, updated.userId);
    return updated;
  }

  @Delete(':id')
  async deleteInquiry(@Param('id') id: string) {
    return this.inquiriesService.deleteInquiry(id);
  }
}

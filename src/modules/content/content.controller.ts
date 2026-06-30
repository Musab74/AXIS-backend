import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { FaqCategory, NoticeStatus } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { ContentService } from './content.service';
import { CreateNoticeDto } from './dto/create-notice.dto';
import { UpdateNoticeDto } from './dto/update-notice.dto';
import { CreateFaqDto } from './dto/create-faq.dto';
import { UpdateFaqDto } from './dto/update-faq.dto';

/* ── Public Notices (no auth) ────────────────────────── */

@Controller('notices')
export class PublicNoticesController {
  constructor(private readonly contentService: ContentService) {}

  @Get()
  async getNotices(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.contentService.getPublicNotices(
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @Get(':id')
  async getNotice(@Param('id') id: string) {
    return this.contentService.getPublicNoticeById(id);
  }
}

/* ── Public FAQ (no auth) ────────────────────────────── */

@Controller('faq')
export class PublicFaqController {
  constructor(private readonly contentService: ContentService) {}

  @Get()
  async getFaqs(@Query('category') category?: FaqCategory) {
    return this.contentService.getPublicFaqs(category);
  }
}

/* ── Admin Notices ───────────────────────────────────── */

@Controller('admin/notices')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'EXAM_ADMIN')
export class AdminNoticesController {
  constructor(private readonly contentService: ContentService) {}

  @Get()
  async getNotices(
    @Query('status') status?: NoticeStatus,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.contentService.getAllNotices({
      status,
      search,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  @Get(':id')
  async getNotice(@Param('id') id: string) {
    return this.contentService.getNoticeById(id);
  }

  @Post()
  async createNotice(@Body() dto: CreateNoticeDto) {
    return this.contentService.createNotice(dto);
  }

  @Put(':id')
  async updateNotice(@Param('id') id: string, @Body() dto: UpdateNoticeDto) {
    return this.contentService.updateNotice(id, dto);
  }

  @Delete(':id')
  async deleteNotice(@Param('id') id: string) {
    return this.contentService.deleteNotice(id);
  }
}

/* ── Admin FAQ ───────────────────────────────────────── */

@Controller('admin/faq')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'EXAM_ADMIN')
export class AdminFaqController {
  constructor(private readonly contentService: ContentService) {}

  @Get()
  async getFaqs(
    @Query('category') category?: FaqCategory,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.contentService.getAllFaqs({
      category,
      search,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }

  @Get(':id')
  async getFaq(@Param('id') id: string) {
    return this.contentService.getFaqById(id);
  }

  @Post()
  async createFaq(@Body() dto: CreateFaqDto) {
    return this.contentService.createFaq(dto);
  }

  @Put(':id')
  async updateFaq(@Param('id') id: string, @Body() dto: UpdateFaqDto) {
    return this.contentService.updateFaq(id, dto);
  }

  @Delete(':id')
  async deleteFaq(@Param('id') id: string) {
    return this.contentService.deleteFaq(id);
  }
}

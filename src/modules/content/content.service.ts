import { Injectable, NotFoundException } from '@nestjs/common';
import { FaqCategory, NoticeStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { CreateNoticeDto } from './dto/create-notice.dto';
import { UpdateNoticeDto } from './dto/update-notice.dto';
import { CreateFaqDto } from './dto/create-faq.dto';
import { UpdateFaqDto } from './dto/update-faq.dto';

export interface NoticeFilters {
  status?: NoticeStatus;
  search?: string;
  page?: number;
  limit?: number;
}

export interface FaqFilters {
  category?: FaqCategory;
  search?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class ContentService {
  constructor(private readonly prisma: PrismaService) {}

  /* ── Public notice endpoints ─────────────────────────── */

  async getPublicNotices(page = 1, limit = 20) {
    const take = Math.min(limit, 100);
    const skip = (page - 1) * take;

    const where = { status: NoticeStatus.PUBLISHED };

    const [notices, total] = await Promise.all([
      this.prisma.notice.findMany({
        where,
        orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
        skip,
        take,
      }),
      this.prisma.notice.count({ where }),
    ]);

    return {
      notices,
      pagination: { page, limit: take, total, totalPages: Math.ceil(total / take) },
    };
  }

  async getPublicNoticeById(id: string) {
    const notice = await this.prisma.notice.findFirst({
      where: { id, status: NoticeStatus.PUBLISHED },
    });
    if (!notice) throw new NotFoundException('Notice not found');

    await this.prisma.notice.update({ where: { id }, data: { views: { increment: 1 } } });
    return { ...notice, views: notice.views + 1 };
  }

  /* ── Admin notice endpoints ──────────────────────────── */

  async getAllNotices(filters: NoticeFilters) {
    const page = filters.page ?? 1;
    const limit = Math.min(filters.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.search) {
      where.OR = [
        { title: { contains: filters.search } },
        { titleEn: { contains: filters.search } },
        { content: { contains: filters.search } },
        { contentEn: { contains: filters.search } },
      ];
    }

    const [notices, total] = await Promise.all([
      this.prisma.notice.findMany({
        where,
        orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.notice.count({ where }),
    ]);

    return {
      notices,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getNoticeById(id: string) {
    const notice = await this.prisma.notice.findUnique({ where: { id } });
    if (!notice) throw new NotFoundException('Notice not found');
    return notice;
  }

  async createNotice(dto: CreateNoticeDto) {
    return this.prisma.notice.create({
      data: {
        tag: dto.tag,
        tagEn: dto.tagEn ?? null,
        tagType: dto.tagType ?? 'NORMAL',
        title: dto.title,
        titleEn: dto.titleEn ?? null,
        content: dto.content,
        contentEn: dto.contentEn ?? null,
        status: dto.status ?? 'DRAFT',
        pinned: dto.pinned ?? false,
      },
    });
  }

  async updateNotice(id: string, dto: UpdateNoticeDto) {
    await this.getNoticeById(id);
    return this.prisma.notice.update({ where: { id }, data: dto });
  }

  async deleteNotice(id: string) {
    await this.getNoticeById(id);
    return this.prisma.notice.delete({ where: { id } });
  }

  /* ── Public FAQ endpoints ────────────────────────────── */

  async getPublicFaqs(category?: FaqCategory) {
    const where: any = { published: true };
    if (category) where.category = category;

    return this.prisma.faq.findMany({
      where,
      orderBy: [{ pinned: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
  }

  /* ── Admin FAQ endpoints ─────────────────────────────── */

  async getAllFaqs(filters: FaqFilters) {
    const page = filters.page ?? 1;
    const limit = Math.min(filters.limit ?? 50, 100);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (filters.category) where.category = filters.category;
    if (filters.search) {
      where.OR = [
        { question: { contains: filters.search } },
        { answer: { contains: filters.search } },
      ];
    }

    const [faqs, total] = await Promise.all([
      this.prisma.faq.findMany({
        where,
        orderBy: [{ pinned: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.faq.count({ where }),
    ]);

    return {
      faqs,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getFaqById(id: string) {
    const faq = await this.prisma.faq.findUnique({ where: { id } });
    if (!faq) throw new NotFoundException('FAQ not found');
    return faq;
  }

  async createFaq(dto: CreateFaqDto) {
    return this.prisma.faq.create({
      data: {
        category: dto.category ?? 'OTHER',
        question: dto.question,
        answer: dto.answer,
        sortOrder: dto.sortOrder ?? 0,
        pinned: dto.pinned ?? false,
        published: dto.published ?? true,
      },
    });
  }

  async updateFaq(id: string, dto: UpdateFaqDto) {
    await this.getFaqById(id);
    return this.prisma.faq.update({ where: { id }, data: dto });
  }

  async deleteFaq(id: string) {
    await this.getFaqById(id);
    return this.prisma.faq.delete({ where: { id } });
  }
}

import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InquiryCategory, InquiryStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { CreateInquiryDto, CreateReplyDto } from './dto/create-inquiry.dto';

export type { CreateInquiryDto, CreateReplyDto };

export interface InquiryFilters {
  status?: InquiryStatus;
  category?: InquiryCategory;
  search?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class InquiriesService {
  constructor(private readonly prisma: PrismaService) {}

  async createInquiry(userId: string, dto: CreateInquiryDto) {
    const inquiry = await this.prisma.inquiry.create({
      data: {
        userId,
        category: dto.category,
        title: dto.title,
        content: dto.content,
        status: 'PENDING',
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });
    return inquiry;
  }

  async getUserInquiries(userId: string, page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    const [inquiries, total] = await Promise.all([
      this.prisma.inquiry.findMany({
        where: { userId },
        include: {
          replies: {
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.inquiry.count({ where: { userId } }),
    ]);

    return {
      inquiries,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getInquiryById(id: string, userId?: string) {
    const inquiry = await this.prisma.inquiry.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
        replies: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!inquiry) {
      throw new NotFoundException('Inquiry not found');
    }

    if (userId && inquiry.userId !== userId) {
      throw new ForbiddenException('Not authorized to view this inquiry');
    }

    return inquiry;
  }

  async addReply(inquiryId: string, authorId: string, dto: CreateReplyDto, isAdmin: boolean) {
    const inquiry = await this.prisma.inquiry.findUnique({
      where: { id: inquiryId },
    });

    if (!inquiry) {
      throw new NotFoundException('Inquiry not found');
    }

    if (!isAdmin && inquiry.userId !== authorId) {
      throw new ForbiddenException('Not authorized to reply to this inquiry');
    }

    const content = dto.content?.trim();
    if (!content) {
      throw new BadRequestException('Reply content is required');
    }

    const reply = await this.prisma.inquiryReply.create({
      data: {
        inquiryId,
        authorId,
        content,
        isAdmin,
      },
    });

    if (isAdmin && inquiry.status === 'PENDING') {
      await this.prisma.inquiry.update({
        where: { id: inquiryId },
        data: { status: 'ANSWERED' },
      });
    }

    return reply;
  }

  async getAllInquiries(filters: InquiryFilters) {
    const page = filters.page ?? 1;
    const limit = Math.min(filters.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.category) where.category = filters.category;
    if (filters.search) {
      where.OR = [
        { title: { contains: filters.search } },
        { content: { contains: filters.search } },
      ];
    }

    const [inquiries, total] = await Promise.all([
      this.prisma.inquiry.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true } },
          replies: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
          _count: { select: { replies: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.inquiry.count({ where }),
    ]);

    return {
      inquiries,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getInquiryStats() {
    const [total, pending, answered, byCategory] = await Promise.all([
      this.prisma.inquiry.count(),
      this.prisma.inquiry.count({ where: { status: 'PENDING' } }),
      this.prisma.inquiry.count({ where: { status: 'ANSWERED' } }),
      this.prisma.inquiry.groupBy({
        by: ['category'],
        _count: { _all: true },
      }),
    ]);

    return {
      total,
      pending,
      answered,
      byCategory: byCategory.map((c) => ({ category: c.category, count: c._count._all })),
    };
  }

  async updateStatus(id: string, status: InquiryStatus) {
    return this.prisma.inquiry.update({
      where: { id },
      data: { status },
    });
  }

  async deleteInquiry(id: string) {
    return this.prisma.inquiry.delete({ where: { id } });
  }
}

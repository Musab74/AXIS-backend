import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CertLevel, CertType, ExamPart } from '@prisma/client';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { AdminQuestionsService, CsvUploadKind } from './admin-questions.service';

function parsePositiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new BadRequestException(`${label} must be a positive integer`);
  }
  return n;
}

function parseOptionalNonNegInt(raw: string | undefined, label: string): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new BadRequestException(`${label} must be a non-negative integer`);
  }
  return n;
}

@Controller('admin/questions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'EXAM_ADMIN', 'GRADING_ADMIN')
export class AdminQuestionsController {
  constructor(private readonly questionsService: AdminQuestionsService) {}

  @Get('stats')
  async getQuestionStats() {
    return this.questionsService.getQuestionStats();
  }

  @Get('subjects')
  async getSubjects() {
    return this.questionsService.getSubjects();
  }

  @Get('list')
  async getQuestions(
    @Query('certType') certType?: CertType,
    @Query('level') level?: CertLevel,
    @Query('subjectIndex') subjectIndex?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.questionsService.getQuestions({
      certType,
      level,
      subjectIndex: parseOptionalNonNegInt(subjectIndex, 'subjectIndex'),
      search,
      page: parsePositiveInt(page, 1, 'page'),
      limit: parsePositiveInt(limit, 20, 'limit'),
    });
  }

  @Get('template')
  getTemplate(@Query('type') type: string | undefined, @Res() res: Response) {
    const kind: CsvUploadKind = type === 'task' ? 'task' : 'mcq';
    const tpl = this.questionsService.getCsvTemplate(kind);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${tpl.fileName}"`);
    res.send(tpl.content);
  }

  @Post('upload')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async uploadCsv(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('file is required');
    return this.questionsService.uploadCsv(file);
  }

  @Get(':id')
  async getQuestionById(@Param('id') id: string) {
    return this.questionsService.getQuestionById(id);
  }
}

@Controller('admin/tasks')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'EXAM_ADMIN', 'GRADING_ADMIN')
export class AdminTasksController {
  constructor(private readonly questionsService: AdminQuestionsService) {}

  @Get('stats')
  async getTaskStats() {
    return this.questionsService.getTaskStats();
  }

  @Get('list')
  async getTasks(
    @Query('certType') certType?: CertType,
    @Query('level') level?: CertLevel,
    @Query('part') part?: ExamPart,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.questionsService.getTasks({
      certType,
      level,
      part,
      search,
      page: parsePositiveInt(page, 1, 'page'),
      limit: parsePositiveInt(limit, 20, 'limit'),
    });
  }

  @Get(':id')
  async getTaskById(@Param('id') id: string) {
    return this.questionsService.getTaskById(id);
  }
}

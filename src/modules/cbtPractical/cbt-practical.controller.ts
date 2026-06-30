import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CbtPracticalService } from './cbt-practical.service';
import { SavePracticalDto, AskPracticalAiDto } from '../cbtSessions/cbt-sessions.dto';

const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
]);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

@Controller('cbt/sessions/:id')
@UseGuards(JwtAuthGuard)
export class CbtPracticalController {
  constructor(private readonly svc: CbtPracticalService) {}

  @Post('practical')
  save(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: SavePracticalDto) {
    return this.svc.save(userId, id, dto);
  }

  @Post('practical/ai')
  askAi(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: AskPracticalAiDto) {
    return this.svc.askAi(userId, id, dto);
  }

  /**
   * Upload a deliverable file for an L1 DELIVERABLE-part task.
   * Accepts PDF, DOCX, ZIP, PNG, JPEG up to 10 MB. Stores in NCP
   * `axis-deliverables` bucket; writes `attachmentUrl` to `EssayAnswer`.
   */
  @Post('deliverable')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  uploadDeliverable(
    @CurrentUser('id') userId: string,
    @Param('id') sessionId: string,
    @Query('taskId') taskId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!taskId) throw new BadRequestException('taskId query param is required');
    if (!file) throw new BadRequestException('file is required');
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException(
        `File type "${file.mimetype}" is not allowed. Accepted: PDF, DOCX, ZIP, PNG, JPEG.`,
      );
    }
    return this.svc.uploadDeliverable(userId, sessionId, taskId, file);
  }
}

import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UPLOAD_ROOT } from '../../main';

/**
 * Inquiry attachment uploads.
 *
 * The Inquiry / InquiryReply schema doesn't have a dedicated attachments
 * column, and per our prod-safety rule we are NOT adding one. Instead,
 * the client embeds attachment markers inside the existing `content`
 * column using the format:
 *
 *     [[attachment|<url>|<filename>|<mimeType>|<size>]]
 *
 * The renderer in QnAPage / InquiryPage parses these markers back out
 * and shows images inline / non-images as download links.
 *
 * That keeps the wire shape backward-compatible with any existing
 * inquiries already in the database, and inquiries created without
 * attachments are byte-for-byte identical to before.
 */

const MAX_FILE_BYTES = 15 * 1024 * 1024;

// Generous on purpose: students may need to send screenshots, scans of
// receipts, PDFs of ID, etc. We block clearly dangerous types
// (executables, scripts) rather than maintaining a strict allowlist.
const FORBIDDEN_EXT = new Set([
  '.exe',
  '.dll',
  '.so',
  '.bat',
  '.cmd',
  '.com',
  '.msi',
  '.sh',
  '.ps1',
  '.vbs',
  '.scr',
  '.cpl',
  '.jar',
  '.app',
  '.apk',
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.php',
  '.py',
  '.rb',
  '.pl',
]);

function sanitizeOriginalName(name: string): string {
  const base = name.replace(/[\r\n\\/]+/g, '_').slice(-200);
  return base || 'file';
}

@Controller('inquiries/uploads')
@UseGuards(JwtAuthGuard)
export class InquiryUploadsController {
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_FILE_BYTES, files: 1 },
      fileFilter: (_req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase();
        if (FORBIDDEN_EXT.has(ext)) {
          return cb(new BadRequestException('File type not allowed'), false);
        }
        cb(null, true);
      },
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          cb(null, join(UPLOAD_ROOT, 'inquiries'));
        },
        filename: (_req, file, cb) => {
          const ext = extname(file.originalname).toLowerCase().slice(0, 10);
          cb(null, `${randomUUID()}${ext}`);
        },
      }),
    }),
  )
  upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    return {
      url: `/uploads/inquiries/${file.filename}`,
      filename: sanitizeOriginalName(file.originalname),
      mimeType: file.mimetype,
      size: file.size,
    };
  }
}

import {
  Controller,
  Get,
  GoneException,
  HttpCode,
  Logger,
  NotFoundException,
  Query,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { createReadStream, existsSync, statSync } from 'fs';
import { extname } from 'path';
import { NcObjectStorageService } from '../../integrations/ncObjectStorage/nc-object-storage.service';

/**
 * Public, HMAC-signed endpoint that streams evidence frames written by the
 * local-fallback path of `NcObjectStorageService` (i.e. when NCP_ACCESS_KEY
 * is not configured). The URL itself carries `b`, `k`, `exp`, `sig` query
 * params; the controller validates the signature against the JWT secret
 * before serving any bytes — same security model as an S3 pre-signed URL.
 *
 * No JwtAuthGuard, by design: the admin browser renders these as `<img src>`
 * and `<audio src>` and cannot send bearer headers. When NCP IS configured,
 * `signedGetUrl()` returns real S3 URLs and this controller is never called.
 */
@ApiExcludeController()
@Controller('proctor/local-evidence')
export class LocalEvidenceController {
  private readonly logger = new Logger(LocalEvidenceController.name);

  constructor(private readonly ncp: NcObjectStorageService) {}

  @Get()
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async stream(
    @Query('b') bucket: string,
    @Query('k') key: string,
    @Query('exp') expRaw: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ) {
    const exp = Number(expRaw);
    if (!bucket || !key || !sig || !Number.isFinite(exp)) {
      throw new NotFoundException();
    }
    if (!this.ncp.verifyLocalSignature(bucket, key, exp, sig)) {
      // 410 Gone reads as "the link expired or was tampered with" without
      // leaking whether the underlying file exists.
      throw new GoneException('Link expired or invalid');
    }
    const filePath = this.ncp.resolveLocalPath(bucket, key);
    if (!filePath || !existsSync(filePath)) {
      throw new NotFoundException();
    }

    const stat = statSync(filePath);
    res.setHeader('Content-Type', mimeFor(filePath));
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    createReadStream(filePath).pipe(res);
  }
}

function mimeFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webm':
      return 'video/webm';
    case '.mp4':
      return 'video/mp4';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

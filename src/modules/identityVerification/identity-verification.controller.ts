import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma.service';
import { VerifyIdentityDto } from './dto/verify-identity.dto';
import {
  IdentityVerificationResult,
  IdentityVerificationService,
} from './identity-verification.service';

interface AuthUser {
  id: string;
  name: string;
}

@ApiTags('identity-verification')
@ApiBearerAuth()
@Controller('identity-verification')
@UseGuards(JwtAuthGuard)
export class IdentityVerificationController {
  constructor(
    private readonly service: IdentityVerificationService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('verify')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'idCard', maxCount: 1 },
        { name: 'liveFace', maxCount: 1 },
      ],
      { limits: { fileSize: 8 * 1024 * 1024 } },
    ),
  )
  async verify(
    @CurrentUser() user: AuthUser,
    @UploadedFiles()
    files: { idCard?: Express.Multer.File[]; liveFace?: Express.Multer.File[] },
    @Body() dto: VerifyIdentityDto,
  ): Promise<IdentityVerificationResult> {
    const idFile = files.idCard?.[0];
    const liveFile = files.liveFace?.[0];
    if (!idFile) throw new BadRequestException('idCard file is required');
    if (!liveFile) throw new BadRequestException('liveFace file is required');

    const expectedName = dto.expectedName ?? user.name;
    const expectedBirthDate = dto.expectedBirthDate ?? (await this.lookupBirthDate(user.id));

    return this.service.verify({
      idImage: idFile.buffer,
      idImageMime: idFile.mimetype,
      liveFaceImage: liveFile.buffer,
      expectedName,
      expectedBirthDate,
    });
  }

  private async lookupBirthDate(userId: string): Promise<string | undefined> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { birthDate: true },
    });
    const stored = u?.birthDate;
    if (!stored) return undefined;
    // Stored as YYYYMMDD (NICE format) — normalize to YYYY-MM-DD.
    if (/^\d{8}$/.test(stored)) {
      return `${stored.slice(0, 4)}-${stored.slice(4, 6)}-${stored.slice(6, 8)}`;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(stored)) return stored;
    return undefined;
  }
}

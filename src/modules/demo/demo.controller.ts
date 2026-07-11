import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CertLevel, CertType } from '@prisma/client';
import { ArrayMinSize, IsArray, IsEnum, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/types/authenticated-user';
import { DemoService } from './demo.service';

class DemoAnswerDto {
  @IsString()
  questionId!: string;

  @IsOptional()
  @IsString()
  selectedChoice!: string | null;
}

class GradeDemoDto {
  @IsEnum(CertType)
  certType!: CertType;

  @IsEnum(CertLevel)
  level!: CertLevel;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DemoAnswerDto)
  answers!: DemoAnswerDto[];
}

class IssueDemoCertDto {
  @IsEnum(CertType)
  certType!: CertType;

  @IsEnum(CertLevel)
  level!: CertLevel;
}

@ApiTags('Demo')
@Controller('cbt/demo')
export class DemoController {
  constructor(private readonly svc: DemoService) {}

  // Still public — OptionalJwtAuthGuard never rejects. A logged-in caller is
  // identified so the ENGLISH_TEST_USER QA gate can translate the paper.
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':certType/:level')
  @ApiOperation({ summary: 'Get a demo exam paper (no auth, no scoring persisted)' })
  paper(
    @Param('certType') certType: CertType,
    @Param('level') level: CertLevel,
    @CurrentUser() user?: AuthenticatedUser | null,
  ) {
    return this.svc.getDemoPaper(certType, level, user);
  }

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Post('grade')
  @ApiOperation({ summary: 'Grade a demo submission (no persistence)' })
  grade(@Body() dto: GradeDemoDto, @CurrentUser() user?: AuthenticatedUser | null) {
    return this.svc.gradeDemo(dto, user);
  }

  @UseGuards(JwtAuthGuard)
  @Post('certificate')
  @ApiOperation({
    summary: 'Issue a stateless DEMO trial certificate for the current user (no DB persistence)',
  })
  issueCertificate(@CurrentUser('id') userId: string, @Body() dto: IssueDemoCertDto) {
    return this.svc.issueDemoCertificate(userId, dto.certType, dto.level);
  }
}

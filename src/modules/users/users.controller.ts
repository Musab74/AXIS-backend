import { Controller, Get, Patch, Post, Body, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UsersService } from './users.service';
import { UpdatePhoneDto } from './dto/update-phone.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '내 프로필 조회' })
  async getProfile(@Req() req: Request) {
    const user = req.user as { id: string };
    return this.usersService.getProfile(user.id);
  }

  @Patch('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '프로필 수정 (이메일 등)' })
  async updateProfile(
    @Req() req: Request,
    @Body() body: { email?: string },
  ) {
    const user = req.user as { id: string };
    return this.usersService.updateProfile(user.id, body);
  }

  @Patch('profile/phone')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '휴대전화 변경 (NICE 본인인증 필수)' })
  async updatePhone(@Req() req: Request, @Body() dto: UpdatePhoneDto) {
    const user = req.user as { id: string };
    return this.usersService.updatePhoneWithNice(user.id, dto.niceSessionId, dto.phone);
  }

  @Post('password')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '비밀번호 변경 (현재 비밀번호 확인)' })
  async changePassword(@Req() req: Request, @Body() dto: ChangePasswordDto) {
    const user = req.user as { id: string };
    return this.usersService.changePassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
    );
  }
}

import {
  Controller,
  Post,
  Patch,
  Body,
  Get,
  Param,
  Query,
  Req,
  Res,
  All,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { NiceRequestDto } from './dto/nice-request.dto';
import { NiceCallbackDto } from './dto/nice-callback.dto';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UsersService } from '../users/users.service';
import { ChangePasswordDto } from '../users/dto/change-password.dto';
import { UpdatePhoneDto } from '../users/dto/update-phone.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
    private readonly usersService: UsersService,
  ) {}

  private readNiceEncodeData(req: Request): string {
    if (req.method === 'GET') {
      return String(req.query.EncodeData ?? req.query.enc_data ?? '');
    }
    const b = req.body as Record<string, unknown> | undefined;
    return String(b?.EncodeData ?? b?.enc_data ?? '');
  }

  private niceClosePopupHtml(title: string): string {
    // No postMessage — opener polls /auth/nice/session/:id (works on mobile where
    // window.opener is null after cross-origin redirects). Bridge just decrypts, persists, closes.
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${title}</title></head><body>
<script>try{window.close();}catch(e){}</script>
<p style="font-family:sans-serif;text-align:center;margin-top:40px">본인인증이 완료되었습니다. 이 창은 자동으로 닫힙니다.</p>
</body></html>`;
  }

  /**
   * NICE redirects the popup here (POST mobile / GET PC) with response EncodeData.
   * We decrypt + persist server-side; the opener polls /auth/nice/session/:id for the result.
   * Register this full URL in NICE admin (RTN_URL / return URL).
   */
  @All('nice/checkplus-return')
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  async handleCheckplusReturn(@Req() req: Request, @Res() res: Response) {
    const encData = this.readNiceEncodeData(req);
    await this.authService.processNiceReturn(encData, 'CHECKPLUS');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(this.niceClosePopupHtml('본인인증'));
  }

  @All('nice/ipin-return')
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  async handleIpinReturn(@Req() req: Request, @Res() res: Response) {
    const encData = this.readNiceEncodeData(req);
    await this.authService.processNiceReturn(encData, 'IPIN');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(this.niceClosePopupHtml('아이핀'));
  }

  /** Polled by signup page while NICE is in progress; returns SUCCESS/FAILED/PENDING. */
  @Get('nice/session/:sessionId')
  @SkipThrottle()
  async getNiceSessionStatus(@Param('sessionId') sessionId: string) {
    return this.authService.getNiceSessionStatus(sessionId);
  }

  /**
   * Step 1: NICE 본인인증 요청
   * Frontend가 이 API를 호출 → 받은 encData로 NICE 팝업 오픈
   */
  @Post('nice/request')
  @ApiOperation({
    summary: 'NICE 본인인증 요청',
    description: 'PASS 또는 I-PIN 인증을 위한 암호화 데이터를 생성합니다',
  })
  @ApiResponse({ status: 200, description: '인증 요청 데이터 반환' })
  async requestNiceVerification(
    @Body() dto: NiceRequestDto,
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.socket.remoteAddress;
    return this.authService.requestNiceVerification(dto.authType, ipAddress);
  }

  /**
   * Step 2: NICE 인증 결과 콜백
   * NICE에서 인증 완료 후 호출됨 → 복호화하여 인증 정보 반환
   */
  @Post('nice/callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'NICE 인증 결과 처리',
    description: 'NICE 인증 완료 후 결과를 복호화하여 사용자 정보를 반환합니다',
  })
  @ApiResponse({
    status: 200,
    description: '인증 성공 시 이름, 전화번호 등 자동 입력 데이터 반환',
  })
  async handleNiceCallback(@Body() dto: NiceCallbackDto) {
    return this.authService.handleNiceCallback(
      dto.encData,
      dto.authType,
      dto.requestNo,
    );
  }

  /**
   * Step 3: 회원가입 (NICE 인증 완료 후)
   * 사용자 ID + 비밀번호 설정 → 계정 생성
   */
  @Post('signup')
  @ApiOperation({
    summary: '회원가입',
    description: 'NICE 본인인증 완료 후 아이디/비밀번호를 설정하여 가입합니다',
  })
  @ApiResponse({ status: 201, description: '가입 성공, JWT 토큰 반환' })
  @ApiResponse({ status: 400, description: '본인인증 미완료 또는 필수 약관 미동의' })
  @ApiResponse({ status: 409, description: '중복 아이디/이메일/회원' })
  async signup(@Body() dto: SignupDto, @Req() req: Request) {
    const ipAddress = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    return this.authService.signup(dto, ipAddress, userAgent);
  }

  /**
   * 로그인 (아이디 + 비밀번호)
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '로그인',
    description: '아이디와 비밀번호로 로그인합니다',
  })
  @ApiResponse({ status: 200, description: '로그인 성공, JWT 토큰 반환' })
  @ApiResponse({ status: 401, description: '아이디/비밀번호 불일치' })
  async login(@Req() req: Request, @Body() dto: LoginDto) {
    const ip = this.extractIp(req);
    const userAgent = req.headers['user-agent'];
    return this.authService.login(dto, { ip, userAgent });
  }

  /**
   * 관리자 포털 로그인 (관리자 역할 계정만 허용)
   */
  @Post('admin/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '관리자 로그인',
    description: '관리자 역할이 있는 계정만 로그인할 수 있습니다',
  })
  @ApiResponse({ status: 200, description: '로그인 성공, JWT 토큰 반환' })
  @ApiResponse({ status: 401, description: '아이디/비밀번호 불일치 또는 관리자 권한 없음' })
  async adminLogin(@Req() req: Request, @Body() dto: LoginDto) {
    const ip = this.extractIp(req);
    const userAgent = req.headers['user-agent'];
    return this.authService.adminLogin(dto, { ip, userAgent });
  }

  /**
   * 비밀번호 재설정 (NICE 인증 완료 후)
   */
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '비밀번호 재설정',
    description: 'NICE 본인인증 완료 후 비밀번호를 재설정합니다',
  })
  @ApiResponse({ status: 200, description: '비밀번호 변경 성공' })
  @ApiResponse({ status: 400, description: '본인인증 미완료' })
  @ApiResponse({ status: 404, description: '등록된 회원 정보 없음' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.niceSessionId, dto.newPassword);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '로그아웃 (현재 기기 세션 종료)' })
  async logout(@CurrentUser('id') userDbId: string) {
    return this.authService.logout(userDbId);
  }

  /** Logged-in password change (current password required). */
  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '비밀번호 변경 (로그인 상태, 현재 비밀번호 확인)' })
  async changePassword(@Req() req: Request, @Body() dto: ChangePasswordDto) {
    const user = req.user as { id: string };
    return this.usersService.changePassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
    );
  }

  /** Logged-in phone update after NICE 본인인증. */
  @Patch('profile-phone')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '휴대전화 변경 (NICE 본인인증)' })
  async updateProfilePhone(@Req() req: Request, @Body() dto: UpdatePhoneDto) {
    const user = req.user as { id: string };
    return this.usersService.updatePhoneWithNice(user.id, dto.niceSessionId, dto.phone);
  }

  /**
   * 토큰 갱신
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '토큰 갱신' })
  async refreshToken(@Body('refreshToken') refreshToken: string) {
    return this.authService.refreshToken(refreshToken);
  }

  /**
   * [DEV ONLY] NICE 본인인증 시뮬레이션
   * 개발 환경에서 실제 NICE 없이 테스트용 인증을 수행합니다
   */
  @Post('nice/dev-verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[DEV] NICE 인증 시뮬레이션',
    description: '개발 환경 전용 — 실제 NICE API 없이 테스트용 본인인증',
  })
  async devNiceVerify(
    @Body() body: { phone: string; authType: 'CHECKPLUS' | 'IPIN' },
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.socket.remoteAddress;
    return this.authService.devNiceVerify(body.phone, body.authType, ipAddress);
  }

  /**
   * 아이디 중복 확인
   */
  @Get('check-userid')
  @ApiOperation({
    summary: '아이디 중복 확인',
    description: '회원가입 시 아이디 사용 가능 여부를 확인합니다',
  })
  async checkUserId(@Query('userId') userId: string) {
    const available = await this.authService.checkUserIdAvailable(userId);
    return { available, userId };
  }

  private extractIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    const headerValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const fromHeader = headerValue?.split(',')[0]?.trim();
    return fromHeader ?? req.ip ?? 'unknown';
  }
}

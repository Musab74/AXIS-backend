import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { NiceRequestDto } from './dto/nice-request.dto';
import { NiceCallbackDto } from './dto/nice-callback.dto';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
    return this.authService.requestNiceVerification(
      dto.authType,
      dto.returnUrl,
      ipAddress,
    );
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
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
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
}

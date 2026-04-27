import {
  Injectable,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../common/prisma.service';
import { NiceAuthService, NiceAuthType } from '../../integrations/niceAuth/nice-auth.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly niceAuth: NiceAuthService,
  ) {}

  // ─── Step 1: NICE 인증 요청 ─────────────────────────────
  async requestNiceVerification(authType: NiceAuthType, returnUrl?: string, ipAddress?: string) {
    const appUrl = this.config.get<string>('appUrl');
    const callbackUrl = returnUrl || `${appUrl}/auth/nice/callback`;

    const niceRequest = this.niceAuth.generateRequest(authType, callbackUrl);

    // Save session for later validation
    const session = await this.prisma.niceSession.create({
      data: {
        requestNo: niceRequest.requestNo,
        encData: niceRequest.encData,
        authType,
        status: 'PENDING',
        ipAddress,
      },
    });

    return {
      sessionId: session.id,
      requestNo: niceRequest.requestNo,
      encData: niceRequest.encData,
      actionUrl: niceRequest.actionUrl,
      authType: niceRequest.authType,
    };
  }

  // ─── Step 2: NICE 콜백 처리 ─────────────────────────────
  async handleNiceCallback(encData: string, authType: NiceAuthType, requestNo: string) {
    // Verify session exists
    const session = await this.prisma.niceSession.findUnique({
      where: { requestNo },
    });

    if (!session) {
      throw new NotFoundException('인증 세션을 찾을 수 없습니다');
    }

    if (session.status !== 'PENDING') {
      throw new BadRequestException('이미 처리된 인증 요청입니다');
    }

    // Decrypt NICE response
    const result = this.niceAuth.decryptResponse(encData, authType);

    if (!result.success) {
      await this.prisma.niceSession.update({
        where: { requestNo },
        data: { status: 'FAILED', completedAt: new Date() },
      });
      throw new BadRequestException(`본인인증 실패: ${result.errorMessage}`);
    }

    // Verify request number matches
    if (result.requestNo !== requestNo) {
      throw new BadRequestException('요청 번호가 일치하지 않습니다');
    }

    // Update session with result
    await this.prisma.niceSession.update({
      where: { requestNo },
      data: {
        status: 'SUCCESS',
        resultData: JSON.stringify(result),
        completedAt: new Date(),
      },
    });

    // Check if CI already exists (duplicate user check)
    if (result.ci) {
      const existingUser = await this.prisma.user.findUnique({
        where: { ci: result.ci },
      });

      if (existingUser) {
        return {
          verified: true,
          alreadyRegistered: true,
          existingUserId: existingUser.userId,
          sessionId: session.id,
          message: '이미 가입된 회원입니다. 로그인해주세요.',
        };
      }
    }

    return {
      verified: true,
      alreadyRegistered: false,
      sessionId: session.id,
      // Auto-fill data for the signup form
      name: result.name,
      phone: result.phone,
      birthDate: result.birthDate,
      gender: result.gender,
    };
  }

  // ─── Step 3: 회원가입 (NICE 인증 완료 후) ─────────────────
  async signup(dto: SignupDto, ipAddress?: string, userAgent?: string) {
    // Validate consents
    if (!dto.agreePrivacy || !dto.agreeTerms) {
      throw new BadRequestException('필수 약관에 동의해주세요');
    }

    // Verify NICE session
    const niceSession = await this.prisma.niceSession.findUnique({
      where: { id: dto.niceSessionId },
    });

    if (!niceSession || niceSession.status !== 'SUCCESS') {
      throw new BadRequestException('본인인증이 완료되지 않았습니다. 먼저 본인인증을 진행해주세요.');
    }

    const niceResult = JSON.parse(niceSession.resultData || '{}');

    // Check duplicate CI
    if (niceResult.ci) {
      const existingByCi = await this.prisma.user.findUnique({
        where: { ci: niceResult.ci },
      });
      if (existingByCi) {
        throw new ConflictException('이미 가입된 회원입니다');
      }
    }

    // Check duplicate userId
    const existingByUserId = await this.prisma.user.findUnique({
      where: { userId: dto.userId },
    });
    if (existingByUserId) {
      throw new ConflictException('이미 사용중인 아이디입니다');
    }

    // Check duplicate email
    if (dto.email) {
      const existingByEmail = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });
      if (existingByEmail) {
        throw new ConflictException('이미 사용중인 이메일입니다');
      }
    }

    // Hash password
    const passwordHash = await bcrypt.hash(dto.password, 12);

    // Create user + role + consent in a transaction
    const user = await this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          userId: dto.userId,
          email: dto.email || null,
          passwordHash,
          name: niceResult.name || '',
          phone: niceResult.phone || '',
          birthDate: niceResult.birthDate || null,
          gender: niceResult.gender || null,
          ci: niceResult.ci || null,
          di: niceResult.di || null,
          niceVerified: true,
          accountStatus: 'ACTIVE',
        },
      });

      // Assign default EXAMINEE role
      await tx.userRole.create({
        data: {
          userId: newUser.id,
          role: 'EXAMINEE',
        },
      });

      // Log consents (PIPA compliance)
      const consents = [
        { consentType: 'TERMS', agreed: dto.agreeTerms },
        { consentType: 'PRIVACY', agreed: dto.agreePrivacy },
        { consentType: 'MARKETING', agreed: dto.agreeMarketing || false },
      ];

      for (const consent of consents) {
        await tx.consentLog.create({
          data: {
            userId: newUser.id,
            consentType: consent.consentType,
            agreed: consent.agreed,
            ipAddress,
            userAgent,
          },
        });
      }

      return newUser;
    });

    // Issue tokens
    const tokens = await this.issueTokens(user.id, user.userId);

    this.logger.log(`New user registered: ${user.userId} (${user.name})`);

    return {
      user: {
        id: user.id,
        userId: user.userId,
        name: user.name,
        phone: user.phone,
        email: user.email,
        birthDate: user.birthDate,
      },
      ...tokens,
    };
  }

  // ─── 로그인 ────────────────────────────────────────────
  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { userId: dto.userId },
      include: { roles: { where: { revokedAt: null } } },
    });

    if (!user) {
      throw new UnauthorizedException('아이디 또는 비밀번호가 올바르지 않습니다');
    }

    if (user.accountStatus === 'SUSPENDED') {
      throw new UnauthorizedException('정지된 계정입니다. 관리자에게 문의하세요.');
    }

    if (user.accountStatus === 'WITHDRAWN') {
      throw new UnauthorizedException('탈퇴한 계정입니다.');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('아이디 또는 비밀번호가 올바르지 않습니다');
    }

    // Update last login
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const tokens = await this.issueTokens(user.id, user.userId);

    return {
      user: {
        id: user.id,
        userId: user.userId,
        name: user.name,
        phone: user.phone,
        email: user.email,
        roles: user.roles.map((r) => r.role),
      },
      ...tokens,
    };
  }

  // ─── 토큰 갱신 ──────────────────────────────────────────
  async refreshToken(refreshToken: string) {
    try {
      const payload = this.jwt.verify(refreshToken, {
        secret: this.config.get<string>('jwt.refreshSecret'),
      });

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
      });

      if (!user || user.accountStatus !== 'ACTIVE') {
        throw new UnauthorizedException('유효하지 않은 토큰입니다');
      }

      return this.issueTokens(user.id, user.userId);
    } catch {
      throw new UnauthorizedException('만료된 토큰입니다. 다시 로그인해주세요.');
    }
  }

  // ─── [DEV] NICE 인증 시뮬레이션 ──────────────────────────
  async devNiceVerify(phone: string, authType: NiceAuthType, ipAddress?: string) {
    const isDevMode = this.config.get<string>('NICE_DEV_MODE') === 'true';
    if (!isDevMode) {
      throw new BadRequestException('Dev mode is disabled');
    }

    const crypto = await import('crypto');
    const requestNo = Date.now().toString() + crypto.randomBytes(4).toString('hex');

    // Create a mock NICE session with fake verified data
    const mockResult = {
      success: true,
      requestNo,
      name: '홍길동',
      phone: phone.replace(/-/g, ''),
      birthDate: '19950315',
      gender: '1',
      nationalInfo: '0',
      ci: 'DEV_CI_' + crypto.randomBytes(16).toString('hex'),
      di: 'DEV_DI_' + crypto.randomBytes(16).toString('hex'),
    };

    const session = await this.prisma.niceSession.create({
      data: {
        requestNo,
        authType,
        status: 'SUCCESS',
        resultData: JSON.stringify(mockResult),
        ipAddress,
        completedAt: new Date(),
      },
    });

    this.logger.warn(`[DEV MODE] NICE verification simulated for phone: ${phone}`);

    return {
      verified: true,
      alreadyRegistered: false,
      sessionId: session.id,
      name: mockResult.name,
      phone: mockResult.phone,
      birthDate: mockResult.birthDate,
      gender: mockResult.gender,
    };
  }

  // ─── 아이디 중복 확인 ───────────────────────────────────
  async checkUserIdAvailable(userId: string): Promise<boolean> {
    const existing = await this.prisma.user.findUnique({
      where: { userId },
    });
    return !existing;
  }

  // ─── JWT 발급 ───────────────────────────────────────────
  private async issueTokens(userDbId: string, userId: string) {
    const payload = { sub: userDbId, userId };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: this.config.get<string>('jwt.accessSecret')!,
        expiresIn: this.config.get<string>('jwt.accessExpiresIn')! as any,
      }),
      this.jwt.signAsync(payload, {
        secret: this.config.get<string>('jwt.refreshSecret')!,
        expiresIn: this.config.get<string>('jwt.refreshExpiresIn')! as any,
      }),
    ]);

    return { accessToken, refreshToken };
  }
}

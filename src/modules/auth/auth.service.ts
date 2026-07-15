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
import { AuthSessionService } from './auth-session.service';
import { LoginAuditService } from './login-audit.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  private static readonly ADMIN_ROLES = [
    'SUPER_ADMIN',
    'EXAM_ADMIN',
    'GRADING_ADMIN',
    'PROCTOR',
    'EXPERT',
  ] as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly niceAuth: NiceAuthService,
    private readonly authSessions: AuthSessionService,
    private readonly loginAudit: LoginAuditService,
  ) {}

  // ─── Step 1: NICE 인증 요청 ─────────────────────────────
  async requestNiceVerification(authType: NiceAuthType, ipAddress?: string) {
    const appUrl = this.config.get<string>('appUrl');
    // Browser must land here after NICE (POST mobile / GET PC) with *response* EncodeData — not the JSON /auth/nice/callback API.
    const callbackUrl =
      authType === 'CHECKPLUS'
        ? `${appUrl}/auth/nice/checkplus-return`
        : `${appUrl}/auth/nice/ipin-return`;

    const niceRequest = await this.niceAuth.generateRequest(authType, callbackUrl);

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

  /**
   * Bridge endpoint helper: decrypt the encData NICE just POSTed back, find the
   * matching NiceSession by REQ_SEQ, persist the result. The frontend polls
   * `getNiceSessionStatus()` afterwards — no postMessage needed (works on mobile
   * Safari where `window.opener` is unreliable across cross-origin redirects).
   */
  async processNiceReturn(encData: string, authType: NiceAuthType): Promise<void> {
    if (!encData) return;

    const result = await this.niceAuth.decryptResponse(encData, authType);
    if (!result.success || !result.requestNo) {
      this.logger.warn(`NICE return: decrypt failed or REQ_SEQ missing — ${JSON.stringify(result)}`);
      return;
    }

    const session = await this.prisma.niceSession.findUnique({
      where: { requestNo: result.requestNo },
    });
    if (!session) {
      this.logger.warn(`NICE return: no session for requestNo=${result.requestNo}`);
      return;
    }
    if (session.status !== 'PENDING') {
      this.logger.warn(`NICE return: session ${session.id} already ${session.status}`);
      return;
    }

    // Mask CI/DI in logs (sensitive PIPA-protected identifiers).
    const fieldSummary = {
      hasCi: !!result.ci,
      hasDi: !!result.di,
      name: result.name ? `${result.name.length}chars` : '(empty)',
      phone: result.phone ? `${result.phone.length}chars` : '(empty)',
      birthDate: result.birthDate || '(empty)',
      gender: result.gender || '(empty)',
      nationalInfo: result.nationalInfo || '(empty)',
    };
    this.logger.log(`NICE return: requestNo=${result.requestNo} fields=${JSON.stringify(fieldSummary)}`);

    // CI is preferred (cross-service identity). DI alone is sufficient for AXIS duplicate-detection
    // since DI is unique per (sitecode + person) and we use one sitecode. Contracts on the basic
    // 본인확인 tier (e.g. BY356) only return DI; we accept that.
    if (!result.ci && !result.di) {
      await this.prisma.niceSession.update({
        where: { requestNo: result.requestNo },
        data: { status: 'FAILED', resultData: JSON.stringify(result), completedAt: new Date() },
      });
      this.logger.warn('NICE return marked FAILED — neither CI nor DI present');
      return;
    }

    await this.prisma.niceSession.update({
      where: { requestNo: result.requestNo },
      data: {
        status: 'SUCCESS',
        resultData: JSON.stringify(result),
        completedAt: new Date(),
      },
    });
  }

  /**
   * Polled by the signup popup-opener every 1-2s while NICE is in progress.
   * Returns PENDING until the bridge stores a result.
   */
  async getNiceSessionStatus(sessionId: string) {
    const session = await this.prisma.niceSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) {
      throw new NotFoundException('세션을 찾을 수 없습니다');
    }

    if (session.status === 'PENDING') {
      return { status: 'PENDING' as const };
    }
    if (session.status === 'FAILED') {
      return { status: 'FAILED' as const, message: '본인인증에 실패했습니다' };
    }

    const result = JSON.parse(session.resultData || '{}');

    // Duplicate check: prefer CI (cross-service), fall back to DI (service-specific) when CI is absent.
    const existingUser = await this.findUserByCiOrDi(result.ci, result.di);
    if (existingUser) {
      return {
        status: 'SUCCESS' as const,
        verified: true,
        alreadyRegistered: true,
        existingUserId: existingUser.userId,
        sessionId: session.id,
        name: result.name,
        phone: result.phone,
        birthDate: result.birthDate,
        gender: result.gender,
        message: '이미 가입된 회원입니다. 로그인해주세요.',
      };
    }

    return {
      status: 'SUCCESS' as const,
      verified: true,
      alreadyRegistered: false,
      sessionId: session.id,
      name: result.name,
      phone: result.phone,
      birthDate: result.birthDate,
      gender: result.gender,
    };
  }

  // ─── Step 2: NICE 콜백 처리 (legacy postMessage path; kept for compat) ───
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
    const result = await this.niceAuth.decryptResponse(encData, authType);

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

    // CI is the cross-service identity hash; missing CI means the response is
    // structurally bad and must not be trusted for duplicate-account checks.
    if (!result.ci) {
      await this.prisma.niceSession.update({
        where: { requestNo },
        data: { status: 'FAILED', completedAt: new Date() },
      });
      throw new BadRequestException('본인인증 응답이 올바르지 않습니다 (CI 누락)');
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

    // Duplicate identity check — CI first (cross-service), DI second (per-sitecode).
    const existingByIdentity = await this.findUserByCiOrDi(niceResult.ci, niceResult.di);
    if (existingByIdentity) {
      throw new ConflictException('이미 가입된 회원입니다');
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

    // Issue tokens — new accounts always get the default EXAMINEE role above,
    // so embed it directly rather than reloading the user.
    const tokens = await this.beginSessionAndIssueTokens(
      user.id,
      user.userId,
      ['EXAMINEE'],
    );

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
  async login(
    dto: LoginDto,
    options?: { adminOnly?: boolean; ip?: string; userAgent?: string },
  ) {
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

    const roles = user.roles.map((r) => r.role);
    if (options?.adminOnly && !roles.some((r) => (AuthService.ADMIN_ROLES as readonly string[]).includes(r))) {
      throw new UnauthorizedException('아이디 또는 비밀번호가 올바르지 않습니다');
    }

    // Update last login
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const tokens = await this.beginSessionAndIssueTokens(user.id, user.userId, roles);

    void this.loginAudit.recordLogin(
      user.id,
      options?.ip,
      options?.userAgent,
      options?.adminOnly ? 'admin' : 'web',
    );

    return {
      user: {
        id: user.id,
        userId: user.userId,
        name: user.name,
        phone: user.phone,
        email: user.email,
        roles,
        mustChangePassword: user.mustChangePassword,
        // Account email gate: accounts created before email became mandatory have
        // none, and we cannot send them a receipt or a deadline warning. The app
        // blocks on this until they supply one. Derived, never stored.
        mustAddEmail: !user.email,
      },
      ...tokens,
    };
  }

  async adminLogin(dto: LoginDto, meta?: { ip?: string; userAgent?: string }) {
    return this.login(dto, { adminOnly: true, ...meta });
  }

  async logout(userDbId: string): Promise<{ ok: true }> {
    await this.authSessions.revokeSession(userDbId);
    return { ok: true };
  }

  // ─── 토큰 갱신 ──────────────────────────────────────────
  async refreshToken(refreshToken: string) {
    try {
      const payload = this.jwt.verify(refreshToken, {
        secret: this.config.get<string>('jwt.refreshSecret'),
      }) as { sub: string; userId: string; sid?: string };

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        include: { roles: { where: { revokedAt: null } } },
      });

      if (!user || user.accountStatus !== 'ACTIVE') {
        throw new UnauthorizedException('유효하지 않은 토큰입니다');
      }

      await this.authSessions.assertSessionActive(user.id, payload.sid);
      await this.authSessions.touchSession(user.id, payload.sid!);

      return this.issueTokens(
        user.id,
        user.userId,
        user.roles.map((r) => r.role),
        payload.sid!,
      );
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      throw new UnauthorizedException('만료된 토큰입니다. 다시 로그인해주세요.');
    }
  }

  // ─── 헬퍼: NICE CI/DI로 기존 사용자 조회 ──────────────────
  // CI may be absent on basic 본인확인 contracts (e.g. BY356); DI is service-specific
  // and unique enough since AXIS uses one sitecode. `di` isn't @unique in the schema
  // yet, so we use findFirst rather than findUnique for the DI fallback.
  private async findUserByCiOrDi(ci?: string | null, di?: string | null) {
    if (ci) {
      const byCi = await this.prisma.user.findUnique({ where: { ci } });
      if (byCi) return byCi;
    }
    if (di) {
      return this.prisma.user.findFirst({ where: { di } });
    }
    return null;
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

  // ─── 비밀번호 재설정 (NICE 인증 완료 후) ──────────────────
  async resetPassword(niceSessionId: string, newPassword: string) {
    const niceSession = await this.prisma.niceSession.findUnique({
      where: { id: niceSessionId },
    });

    if (!niceSession || niceSession.status !== 'SUCCESS') {
      throw new BadRequestException('본인인증이 완료되지 않았습니다. 먼저 본인인증을 진행해주세요.');
    }

    const niceResult = JSON.parse(niceSession.resultData || '{}');

    const user = await this.findUserByCiOrDi(niceResult.ci, niceResult.di);
    if (!user) {
      throw new NotFoundException('등록된 회원 정보를 찾을 수 없습니다');
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false },
    });
    await this.authSessions.revokeSession(user.id);

    this.logger.log(`Password reset for user: ${user.userId}`);

    return { success: true, userId: user.userId };
  }

  // ─── 아이디 중복 확인 ───────────────────────────────────
  async checkUserIdAvailable(userId: string): Promise<boolean> {
    const existing = await this.prisma.user.findUnique({
      where: { userId },
    });
    return !existing;
  }

  // ─── JWT 발급 ───────────────────────────────────────────
  private async beginSessionAndIssueTokens(
    userDbId: string,
    userId: string,
    roles: string[] = [],
  ) {
    const sessionId = await this.authSessions.beginSession(userDbId);
    return this.issueTokens(userDbId, userId, roles, sessionId);
  }

  private async issueTokens(
    userDbId: string,
    userId: string,
    roles: string[] = [],
    sessionId: string,
  ) {
    const payload = { sub: userDbId, userId, roles, sid: sessionId };

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

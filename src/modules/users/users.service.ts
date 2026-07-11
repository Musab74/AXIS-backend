import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../common/prisma.service';
import { AuthSessionService } from '../auth/auth-session.service';

function normalizeBirthDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length === 8 ? digits : null;
}

function normalizeName(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

type NiceIdentityResult = {
  name?: string;
  phone?: string;
  birthDate?: string;
  ci?: string;
  di?: string;
};

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authSessions: AuthSessionService,
  ) {}

  async getProfile(userDbId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userDbId },
      include: { roles: { where: { revokedAt: null } } },
    });

    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다');
    }

    return {
      id: user.id,
      userId: user.userId,
      name: user.name,
      phone: user.phone,
      email: user.email,
      birthDate: user.birthDate,
      gender: user.gender,
      niceVerified: user.niceVerified,
      accountStatus: user.accountStatus,
      roles: user.roles.map((r) => r.role),
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    };
  }

  async updateProfile(userDbId: string, data: { email?: string }) {
    const user = await this.prisma.user.update({
      where: { id: userDbId },
      data: {
        email: data.email,
      },
    });

    return {
      id: user.id,
      userId: user.userId,
      name: user.name,
      email: user.email,
    };
  }

  /**
   * Update phone after NICE 본인인증. The verified identity must belong to the
   * logged-in user (CI/DI) and name + birth date must match stored profile data.
   */
  async updatePhoneWithNice(userDbId: string, niceSessionId: string, requestedPhone: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userDbId } });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다');

    const niceResult = await this.assertNiceSessionMatchesUser(user, niceSessionId);
    const requested = requestedPhone.replace(/\D/g, '');
    const newPhone = (niceResult.phone ?? '').replace(/\D/g, '');
    if (!newPhone || newPhone.length < 10) {
      throw new BadRequestException('본인인증에서 유효한 휴대전화 번호를 받지 못했습니다');
    }
    if (newPhone !== requested) {
      throw new BadRequestException('본인인증 휴대전화 번호가 입력한 번호와 일치하지 않습니다');
    }

    const updated = await this.prisma.user.update({
      where: { id: userDbId },
      data: { phone: newPhone, niceVerified: true },
    });

    return {
      id: updated.id,
      userId: updated.userId,
      phone: updated.phone,
    };
  }

  async changePassword(userDbId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userDbId } });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다');

    const currentOk = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!currentOk) {
      throw new UnauthorizedException('현재 비밀번호가 올바르지 않습니다');
    }

    if (currentPassword === newPassword) {
      throw new BadRequestException('새 비밀번호는 현재 비밀번호와 달라야 합니다');
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({
      where: { id: userDbId },
      data: { passwordHash, mustChangePassword: false },
    });
    await this.authSessions.revokeSession(userDbId);

    return { success: true };
  }

  private async assertNiceSessionMatchesUser(
    user: { id: string; name: string; birthDate: string | null; ci: string | null; di: string | null },
    niceSessionId: string,
  ): Promise<NiceIdentityResult> {
    const session = await this.prisma.niceSession.findUnique({
      where: { id: niceSessionId },
    });
    if (!session || session.status !== 'SUCCESS') {
      throw new BadRequestException('본인인증이 완료되지 않았습니다. NICE 인증을 다시 진행해 주세요.');
    }

    const result = JSON.parse(session.resultData || '{}') as NiceIdentityResult;
    const identityUser = await this.findUserByCiOrDi(result.ci, result.di);
    if (!identityUser || identityUser.id !== user.id) {
      throw new ForbiddenException('본인인증 정보가 로그인 계정과 일치하지 않습니다');
    }

    if (normalizeName(result.name) !== normalizeName(user.name)) {
      throw new BadRequestException('본인인증 성명이 등록된 정보와 일치하지 않습니다');
    }

    const niceBirth = normalizeBirthDate(result.birthDate);
    const userBirth = normalizeBirthDate(user.birthDate);
    if (!niceBirth || !userBirth || niceBirth !== userBirth) {
      throw new BadRequestException('본인인증 생년월일이 등록된 정보와 일치하지 않습니다');
    }

    return result;
  }

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
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

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
}

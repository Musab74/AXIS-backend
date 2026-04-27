import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.accessSecret') || 'fallback',
    });
  }

  async validate(payload: { sub: string; userId: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { roles: { where: { revokedAt: null } } },
    });

    if (!user || user.accountStatus !== 'ACTIVE') {
      throw new UnauthorizedException();
    }

    return {
      id: user.id,
      userId: user.userId,
      name: user.name,
      roles: user.roles.map((r) => r.role),
    };
  }
}

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma.service';
import { AuthSessionService } from '../auth-session.service';

type JwtPayload = {
  sub: string;
  userId: string;
  sid?: string;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly authSessions: AuthSessionService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.accessSecret') || 'fallback',
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { roles: { where: { revokedAt: null } } },
    });

    if (!user || user.accountStatus !== 'ACTIVE') {
      throw new UnauthorizedException();
    }

    await this.authSessions.assertSessionActive(user.id, payload.sid);

    return {
      id: user.id,
      userId: user.userId,
      name: user.name,
      roles: user.roles.map((r) => r.role),
      sid: payload.sid,
    };
  }
}

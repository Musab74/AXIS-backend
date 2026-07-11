import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Like JwtAuthGuard but never rejects: a valid Bearer token populates
 * `req.user`, while a missing/invalid/expired token leaves it undefined and
 * the request proceeds anonymously. Use on public endpoints whose behavior is
 * only *personalized* when the caller happens to be logged in (e.g. the demo
 * paper, which is translated for the single ENGLISH_TEST_USER).
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = unknown>(_err: unknown, user: TUser | false): TUser | null {
    return user || null;
  }
}

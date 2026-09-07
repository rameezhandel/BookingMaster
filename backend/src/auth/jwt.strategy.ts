import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AuthUser } from '../common/current-user.decorator';

export interface JwtPayload {
  sub: string;
  tid: string;
  email: string;
  name: string;
  role: 'owner' | 'staff';
  /** Distinguishes staff tokens from customer tokens signed with the same key. */
  typ: 'owner';
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: JwtPayload): AuthUser {
    // Without this check a customer token — same signing key, far weaker
    // identity proof — would authenticate against the whole owner console.
    if (payload?.typ !== 'owner') throw new UnauthorizedException();
    if (!payload?.sub || !payload?.tid) throw new UnauthorizedException();
    return {
      id: payload.sub,
      tenantId: payload.tid,
      email: payload.email,
      name: payload.name,
      role: payload.role,
    };
  }
}

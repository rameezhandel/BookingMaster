import { ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard, PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

/**
 * A customer session, issued after a phone number is verified.
 *
 * Short-lived and scoped to one venue: it proves "this phone can manage its own
 * bookings at this venue", which is a much smaller claim than a staff login.
 */
export interface CustomerPayload {
  sub: string;
  tid: string;
  vid: string;
  phone: string;
  typ: 'customer';
}

export interface CustomerUser {
  id: string;
  /** Named tenantId so the tenant interceptor picks it up like any other request. */
  tenantId: string;
  venueId: string;
  phone: string;
}

export const CUSTOMER_TOKEN_TTL = '2h';

@Injectable()
export class CustomerJwtStrategy extends PassportStrategy(Strategy, 'customer-jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: CustomerPayload): CustomerUser {
    // An owner token must not be usable here either: the two carry different
    // guarantees and should not be interchangeable in either direction.
    if (payload?.typ !== 'customer') throw new UnauthorizedException();
    if (!payload.sub || !payload.tid || !payload.vid) throw new UnauthorizedException();

    return { id: payload.sub, tenantId: payload.tid, venueId: payload.vid, phone: payload.phone };
  }
}

@Injectable()
export class CustomerAuthGuard extends AuthGuard('customer-jwt') {}

export const CurrentCustomer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CustomerUser =>
    ctx.switchToHttp().getRequest().user as CustomerUser,
);

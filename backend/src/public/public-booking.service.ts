import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/database.module';
import { runAsTenant } from '../db/run-as-tenant';
import { customers, reservations, resources, venues } from '../db/schema';
import { CUSTOMER_TOKEN_TTL, type CustomerPayload, type CustomerUser } from './customer-auth';
import { HoldsService } from './holds.service';
import { OtpService } from './otp/otp.service';
import { PublicService } from './public.service';
import type { CreateHoldDto, RequestOtpDto, VerifyOtpDto } from './dto';

@Injectable()
export class PublicBookingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly publicService: PublicService,
    private readonly otp: OtpService,
    private readonly holds: HoldsService,
    private readonly jwt: JwtService,
  ) {}

  /** Both OTP steps run before there is any session, so they adopt the venue's tenant. */
  async requestOtp(slug: string, dto: RequestOtpDto) {
    const venue = await this.publicService.resolveSlug(slug);
    return runAsTenant(this.db, venue.tenantId, () =>
      this.otp.request(venue.tenantId, venue.id, dto.phone),
    );
  }

  async verifyOtp(slug: string, dto: VerifyOtpDto) {
    const venue = await this.publicService.resolveSlug(slug);

    return runAsTenant(this.db, venue.tenantId, async () => {
      const phone = await this.otp.verify(venue.id, dto.challengeId, dto.code);

      // The customer record is shared with the owner console: a player who
      // books online is the same person the owner already has on file, matched
      // on the phone number that was just proved.
      const [customer] = await this.db
        .insert(customers)
        .values({ tenantId: venue.tenantId, name: dto.name?.trim() || phone, phone })
        .onConflictDoUpdate({
          target: [customers.tenantId, customers.phone],
          // Only fill in a name; never overwrite one the venue has curated with
          // whatever a stranger typed.
          set: { name: sql`CASE WHEN ${customers.name} = ${customers.phone} THEN excluded.name ELSE ${customers.name} END` },
        })
        .returning();

      const payload: CustomerPayload = {
        sub: customer.id,
        tid: venue.tenantId,
        vid: venue.id,
        phone,
        typ: 'customer',
      };

      return {
        token: this.jwt.sign(payload, { expiresIn: CUSTOMER_TOKEN_TTL }),
        customer: { id: customer.id, name: customer.name, phone: customer.phone },
      };
    });
  }

  async hold(user: CustomerUser, dto: CreateHoldDto) {
    const interval = parseInterval(dto.start, dto.end);
    return this.holds.create(user.tenantId, user.venueId, user.id, dto.resourceId, interval);
  }

  confirm(user: CustomerUser, holdId: string) {
    return this.holds.confirm(user.tenantId, holdId, user.id);
  }

  release(user: CustomerUser, holdId: string) {
    return this.holds.release(user.tenantId, holdId, user.id);
  }

  /** A customer's own bookings at this venue. Scoped to them by id, not by trust. */
  async mine(user: CustomerUser) {
    return this.db
      .select({
        id: reservations.id,
        status: reservations.status,
        during: reservations.during,
        amountPaise: reservations.amountPaise,
        expiresAt: reservations.expiresAt,
        courtName: resources.name,
        sport: resources.sport,
        venueName: venues.name,
        timezone: venues.timezone,
      })
      .from(reservations)
      .innerJoin(resources, eq(resources.id, reservations.resourceId))
      .innerJoin(venues, eq(venues.id, reservations.venueId))
      .where(
        and(
          eq(reservations.customerId, user.id),
          eq(reservations.venueId, user.venueId),
          gte(sql`upper(${reservations.during})`, sql`now() - interval '1 day'`),
        ),
      )
      .orderBy(desc(sql`lower(${reservations.during})`))
      .limit(50);
  }
}

function parseInterval(start: string, end: string) {
  const interval = { start: new Date(start), end: new Date(end) };
  if (Number.isNaN(interval.start.getTime()) || Number.isNaN(interval.end.getTime())) {
    throw new BadRequestException('Invalid times.');
  }
  return interval;
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/database.module';
import { runAsTenant } from '../db/run-as-tenant';
import { customers, payments as paymentsTable, reservations, resources, venues } from '../db/schema';
import { CUSTOMER_TOKEN_TTL, type CustomerPayload, type CustomerUser } from './customer-auth';
import { paidTotals, toPaise } from '../common/paid-totals';
import { ReservationsService } from '../reservations/reservations.service';
import { CheckoutService } from '../payments/checkout.service';
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
    private readonly reservations: ReservationsService,
    private readonly checkout: CheckoutService,
  ) {}

  private readonly logger = new Logger(PublicBookingService.name);

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

  /**
   * A customer's own bookings at this venue.
   *
   * Scoped by customer id from their verified session, never by anything the
   * request supplies. Recent history is included as well as what is coming up,
   * because "did that get cancelled?" is the question people actually have.
   */
  async mine(user: CustomerUser) {
    const paid = paidTotals(this.db);

    const rows = await this.db
      .select({
        id: reservations.id,
        status: reservations.status,
        during: reservations.during,
        amountPaise: reservations.amountPaise,
        paidPaise: paid.paidPaise,
        expiresAt: reservations.expiresAt,
        cancellationRefundPaise: reservations.cancellationRefundPaise,
        courtName: resources.name,
        sport: resources.sport,
        venueName: venues.name,
        venuePhone: venues.phone,
        timezone: venues.timezone,
      })
      .from(reservations)
      .innerJoin(resources, eq(resources.id, reservations.resourceId))
      .innerJoin(venues, eq(venues.id, reservations.venueId))
      .leftJoin(paid, eq(paid.reservationId, reservations.id))
      .where(
        and(
          eq(reservations.customerId, user.id),
          eq(reservations.venueId, user.venueId),
          gte(sql`upper(${reservations.during})`, sql`now() - interval '30 days'`),
        ),
      )
      .orderBy(desc(sql`lower(${reservations.during})`))
      .limit(60);

    const now = Date.now();
    return rows.map((r) => {
      const amountPaise = toPaise(r.amountPaise);
      const paidPaise = toPaise(r.paidPaise);
      return {
        ...r,
        amountPaise,
        paidPaise,
        cancellationRefundPaise: r.cancellationRefundPaise ? toPaise(r.cancellationRefundPaise) : null,
        // Whether the customer may cancel it themselves, decided here so the
        // page never offers a button the server would refuse.
        cancellable:
          (r.status === 'confirmed' || r.status === 'held') && r.during.end.getTime() > now,
      };
    });
  }

  /** What the venue's policy would refund if this booking were cancelled now. */
  async cancellationQuote(user: CustomerUser, reservationId: string) {
    await this.assertOwn(user, reservationId);
    return this.reservations.quoteCancellation(user.tenantId, reservationId);
  }

  /**
   * Cancels the customer's own booking, applying the venue's policy.
   *
   * The refund amount is the policy's, never one the request supplies. Where
   * the booking was paid through the gateway the money is sent back
   * immediately; where it was paid in cash there is nothing to send, and the
   * response says to collect it from the venue rather than implying it is on
   * its way.
   */
  async cancelOwn(user: CustomerUser, reservationId: string, reason?: string) {
    const booking = await this.assertOwn(user, reservationId);

    if (booking.status === 'cancelled') {
      throw new ConflictException('That booking is already cancelled.');
    }
    if (booking.status !== 'confirmed' && booking.status !== 'held') {
      throw new ConflictException('That booking can no longer be cancelled online.');
    }
    if (booking.during.end.getTime() <= Date.now()) {
      throw new ConflictException('That booking has already finished.');
    }

    const quote = await this.reservations.quoteCancellation(user.tenantId, reservationId);

    // Cancel first: the slot going back on sale must not wait on a gateway
    // call, and a refund that fails is money owed, not a booking still standing.
    await this.reservations.cancel(user.tenantId, reservationId, {
      reason: reason?.trim() || 'Cancelled by the customer',
      // The ledger entry is written below, and only if the money really moved.
      recordRefund: false,
    });

    let refund = { issued: false, detail: 'Nothing to refund.' };
    if (quote.refundPaise > 0) {
      refund = await this.checkout.refundForCancellation(
        user.tenantId,
        reservationId,
        quote.refundPaise,
        'Cancelled by the customer',
      );

      if (refund.issued) {
        await this.db.insert(paymentsTable).values({
          tenantId: user.tenantId,
          reservationId,
          amountPaise: quote.refundPaise,
          direction: 'refund',
          method: 'upi',
          note: 'Refunded on customer cancellation',
        });
      } else {
        this.logger.warn(
          `Booking ${reservationId} cancelled with ${quote.refundPaise} paise owed but not issued.`,
        );
      }
    }

    return {
      cancelled: true,
      refundPaise: quote.refundPaise,
      refundPct: quote.refundPct,
      refundIssued: refund.issued,
      refundDetail: refund.detail,
    };
  }

  private async assertOwn(user: CustomerUser, reservationId: string) {
    const [booking] = await this.db
      .select()
      .from(reservations)
      .where(and(eq(reservations.tenantId, user.tenantId), eq(reservations.id, reservationId)))
      .limit(1);

    // Same 404 whether it is missing or someone else's: a customer must not be
    // able to probe for other people's booking ids.
    if (!booking || booking.customerId !== user.id || booking.venueId !== user.venueId) {
      throw new NotFoundException('No such booking.');
    }
    return booking;
  }
}

function parseInterval(start: string, end: string) {
  const interval = { start: new Date(start), end: new Date(end) };
  if (Number.isNaN(interval.start.getTime()) || Number.isNaN(interval.end.getTime())) {
    throw new BadRequestException('Invalid times.');
  }
  return interval;
}

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DB, type Db } from '../db/database.module';
import {
  OCCUPYING_STATUSES,
  customers,
  enquiries,
  reservations,
  resources,
  venues,
} from '../db/schema';
import { PG_EXCLUSION_VIOLATION } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { CustomersService } from '../customers/customers.service';
import type { BookEnquiryDto, CreateEnquiryDto, UpdateEnquiryDto } from './dto';

@Injectable()
export class EnquiriesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly customersService: CustomersService,
  ) {}

  /**
   * The pipeline, newest first.
   *
   * Everything open by default: an enquiry nobody has answered is the one that
   * costs a booking, so the list an owner opens should be the work, not the
   * archive.
   */
  async list(tenantId: string, venueId: string, opts: { status?: string; includeClosed?: boolean } = {}) {
    const filters = [eq(enquiries.tenantId, tenantId), eq(enquiries.venueId, venueId)];
    if (opts.status) {
      filters.push(eq(enquiries.status, opts.status as 'new'));
    } else if (!opts.includeClosed) {
      filters.push(inArray(enquiries.status, ['new', 'visit_scheduled', 'quoted']));
    }

    return this.db
      .select({
        id: enquiries.id,
        contactName: enquiries.contactName,
        contactPhone: enquiries.contactPhone,
        contactEmail: enquiries.contactEmail,
        eventType: enquiries.eventType,
        eventDate: enquiries.eventDate,
        guestCount: enquiries.guestCount,
        status: enquiries.status,
        visitAt: enquiries.visitAt,
        quotedPaise: enquiries.quotedPaise,
        lostReason: enquiries.lostReason,
        notes: enquiries.notes,
        resourceId: enquiries.resourceId,
        hallName: resources.name,
        reservationId: enquiries.reservationId,
        createdAt: enquiries.createdAt,
      })
      .from(enquiries)
      .leftJoin(resources, eq(resources.id, enquiries.resourceId))
      .where(and(...filters))
      .orderBy(
        // A dated enquiry sorts by the date it is about; an undated one is
        // still a lead and should not fall off the bottom.
        asc(sql`${enquiries.eventDate} IS NULL`),
        asc(enquiries.eventDate),
        desc(enquiries.createdAt),
      )
      .limit(300);
  }

  async get(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(enquiries)
      .where(and(eq(enquiries.tenantId, tenantId), eq(enquiries.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException('No such enquiry.');
    return row;
  }

  async create(tenantId: string, venueId: string, dto: CreateEnquiryDto) {
    await this.assertVenue(tenantId, venueId);
    if (dto.resourceId) await this.assertHall(tenantId, venueId, dto.resourceId);

    const [row] = await this.db
      .insert(enquiries)
      .values({
        tenantId,
        venueId,
        resourceId: dto.resourceId ?? null,
        contactName: dto.contactName.trim(),
        contactPhone: dto.contactPhone.trim(),
        contactEmail: dto.contactEmail?.trim() || null,
        eventType: dto.eventType?.trim() || null,
        eventDate: dto.eventDate ?? null,
        guestCount: dto.guestCount ?? null,
        notes: dto.notes?.trim() || null,
      })
      .returning();

    await this.audit.record({
      action: 'enquiry.created',
      entityType: 'enquiry',
      entityId: row.id,
      summary: `Enquiry from ${row.contactName}${row.eventDate ? ` for ${row.eventDate}` : ''}`,
    });
    return row;
  }

  /**
   * Moves an enquiry along, or records that it went nowhere.
   *
   * `won` is not settable here. An enquiry becomes won by producing a booking,
   * through `book` below — otherwise the pipeline and the calendar drift apart,
   * and the pipeline is the one people stop trusting.
   */
  async update(tenantId: string, id: string, dto: UpdateEnquiryDto) {
    const existing = await this.get(tenantId, id);
    if (existing.status === 'won') {
      throw new BadRequestException(
        'This enquiry is booked. Change the booking itself rather than the enquiry behind it.',
      );
    }
    if (dto.resourceId) await this.assertHall(tenantId, existing.venueId, dto.resourceId);
    if (dto.status === 'lost' && !dto.lostReason?.trim() && !existing.lostReason) {
      throw new BadRequestException('Say why it was lost — that is the only useful part later.');
    }

    const [row] = await this.db
      .update(enquiries)
      .set({
        ...dto,
        visitAt: dto.visitAt ? new Date(dto.visitAt) : undefined,
        // Scheduling a visit is the status change; asking for both is a form
        // people get wrong.
        status: dto.visitAt && !dto.status ? 'visit_scheduled' : dto.status,
      })
      .where(and(eq(enquiries.tenantId, tenantId), eq(enquiries.id, id)))
      .returning();

    if (dto.status && dto.status !== existing.status) {
      await this.audit.record({
        action: `enquiry.${dto.status}`,
        entityType: 'enquiry',
        entityId: id,
        summary: `${row.contactName}'s enquiry is now ${dto.status.replace('_', ' ')}`,
      });
    }
    return row;
  }

  /**
   * Turns an enquiry into something that actually blocks the date.
   *
   * This is the only place an enquiry touches the calendar. Up to here several
   * families can be considering the same Saturday, which is how venues really
   * work; a system that blocked on enquiry would either lose them bookings or
   * teach them to keep the real pipeline on paper.
   *
   * A tentative hold expires in days rather than minutes, and the same sweeper
   * that releases a ten-minute court hold releases it.
   */
  async book(tenantId: string, id: string, dto: BookEnquiryDto) {
    const enquiry = await this.get(tenantId, id);
    if (enquiry.status === 'won') {
      throw new ConflictException('This enquiry has already produced a booking.');
    }
    const hall = await this.assertHall(tenantId, enquiry.venueId, dto.resourceId);
    const [venue] = await this.db
      .select()
      .from(venues)
      .where(eq(venues.id, enquiry.venueId))
      .limit(1);

    const eventStart = new Date(dto.eventStart);
    const eventEnd = new Date(dto.eventEnd);
    if (eventEnd <= eventStart) {
      throw new BadRequestException('The event has to end after it starts.');
    }

    // The hall is unavailable for longer than the event runs unless told
    // otherwise; defaulting them equal keeps the simple case simple.
    const accessStart = dto.accessStart ? new Date(dto.accessStart) : eventStart;
    const accessEnd = dto.accessEnd ? new Date(dto.accessEnd) : eventEnd;
    if (accessStart > eventStart || accessEnd < eventEnd) {
      throw new BadRequestException(
        'The event has to sit inside the window the hall is held for, not outside it.',
      );
    }

    let expiresAt: Date | null = null;
    if (dto.tentative) {
      if (!dto.holdUntil) {
        throw new BadRequestException('A tentative hold needs a date it is released on.');
      }
      // End of that day in the venue's timezone: "held until the 12th" means
      // through the 12th, not from midnight at its start.
      expiresAt = DateTime.fromISO(dto.holdUntil, { zone: venue?.timezone ?? 'Asia/Kolkata' })
        .endOf('day')
        .toJSDate();
      if (expiresAt <= new Date()) {
        throw new BadRequestException('That hold date has already passed.');
      }
      if (expiresAt > accessStart) {
        throw new BadRequestException(
          'A hold cannot outlast the event it is holding. Pick a date before it.',
        );
      }
    }

    try {
      const result = await this.db.transaction(async (tx) => {
        const customer = await this.customersService.findOrCreate(tx, tenantId, {
          name: enquiry.contactName,
          phone: enquiry.contactPhone,
        });

        const [reservation] = await tx
          .insert(reservations)
          .values({
            tenantId,
            venueId: enquiry.venueId,
            resourceId: hall.id,
            kind: 'booking',
            status: dto.tentative ? 'held' : 'confirmed',
            during: { start: accessStart, end: accessEnd },
            eventDuring: { start: eventStart, end: eventEnd },
            customerId: customer.id,
            amountPaise: dto.amountPaise ?? enquiry.quotedPaise ?? 0,
            notes: dto.notes?.trim() || enquiry.notes,
            expiresAt,
          })
          .returning();

        const [updated] = await tx
          .update(enquiries)
          .set({
            resourceId: hall.id,
            customerId: customer.id,
            reservationId: reservation.id,
            // A tentative hold is not a win yet — the family can still walk.
            status: dto.tentative ? 'quoted' : 'won',
            quotedPaise: dto.amountPaise ?? enquiry.quotedPaise,
          })
          .where(eq(enquiries.id, id))
          .returning();

        return { reservation, enquiry: updated };
      });

      await this.audit.record({
        action: dto.tentative ? 'enquiry.held' : 'enquiry.won',
        entityType: 'reservation',
        entityId: result.reservation.id,
        summary: dto.tentative
          ? `Held ${hall.name} for ${enquiry.contactName} until ${dto.holdUntil}`
          : `Booked ${hall.name} for ${enquiry.contactName}`,
        data: { enquiryId: id, amountPaise: result.reservation.amountPaise },
      });
      return result;
    } catch (err) {
      if ((err as { code?: string }).code === PG_EXCLUSION_VIOLATION) {
        throw new ConflictException(
          'That hall is already taken for those dates. Check the diary before promising it.',
        );
      }
      throw err;
    }
  }

  /**
   * Which dates a hall is already spoken for.
   *
   * Answers the question an owner is asked on the phone — "is the 14th free?" —
   * without making them read a grid of hours.
   */
  async availability(tenantId: string, venueId: string, from: string, to: string) {
    const [venue] = await this.db
      .select()
      .from(venues)
      .where(and(eq(venues.tenantId, tenantId), eq(venues.id, venueId)))
      .limit(1);
    if (!venue) throw new NotFoundException('Venue not found.');

    const tz = venue.timezone;
    const start = DateTime.fromISO(from, { zone: tz }).startOf('day');
    const end = DateTime.fromISO(to, { zone: tz }).endOf('day');
    if (!start.isValid || !end.isValid || end < start) {
      throw new BadRequestException('Give a valid date range.');
    }
    if (end.diff(start, 'days').days > 400) {
      throw new BadRequestException('That is more than a year at a time.');
    }

    const halls = await this.db
      .select({ id: resources.id, name: resources.name })
      .from(resources)
      .where(
        and(
          eq(resources.tenantId, tenantId),
          eq(resources.venueId, venueId),
          eq(resources.kind, 'hall'),
          eq(resources.isActive, true),
        ),
      )
      .orderBy(asc(resources.sortOrder), asc(resources.name));

    const taken = await this.db
      .select({
        id: reservations.id,
        resourceId: reservations.resourceId,
        status: reservations.status,
        during: reservations.during,
        eventDuring: reservations.eventDuring,
        expiresAt: reservations.expiresAt,
        customerName: customers.name,
      })
      .from(reservations)
      .leftJoin(customers, eq(customers.id, reservations.customerId))
      .where(
        and(
          eq(reservations.tenantId, tenantId),
          eq(reservations.venueId, venueId),
          inArray(reservations.status, OCCUPYING_STATUSES),
          lte(sql`lower(${reservations.during})`, end.toJSDate()),
          gte(sql`upper(${reservations.during})`, start.toJSDate()),
        ),
      );

    return {
      timezone: tz,
      from: start.toISODate(),
      to: end.toISODate(),
      halls: halls.map((hall) => ({
        ...hall,
        bookings: taken
          .filter((t) => t.resourceId === hall.id)
          .map((t) => ({
            id: t.id,
            status: t.status,
            // Tentative until this date, and released after it.
            holdUntil: t.status === 'held' ? t.expiresAt : null,
            from: DateTime.fromJSDate(t.during.start, { zone: tz }).toISODate(),
            // The last day the hall is actually occupied, inclusive. The range
            // itself is half-open, so an event ending at midnight ends on the
            // day before — and that day is the last one it is unavailable.
            to: DateTime.fromJSDate(t.during.end, { zone: tz }).minus({ millisecond: 1 }).toISODate(),
            eventFrom: t.eventDuring
              ? DateTime.fromJSDate(t.eventDuring.start, { zone: tz }).toISO()
              : null,
            eventTo: t.eventDuring
              ? DateTime.fromJSDate(t.eventDuring.end, { zone: tz }).toISO()
              : null,
            customerName: t.customerName,
          })),
      })),
    };
  }

  private async assertVenue(tenantId: string, venueId: string) {
    const [venue] = await this.db
      .select({ id: venues.id })
      .from(venues)
      .where(and(eq(venues.tenantId, tenantId), eq(venues.id, venueId)))
      .limit(1);
    if (!venue) throw new NotFoundException('Venue not found.');
    return venue;
  }

  private async assertHall(tenantId: string, venueId: string, resourceId: string) {
    const [hall] = await this.db
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.tenantId, tenantId),
          eq(resources.venueId, venueId),
          eq(resources.id, resourceId),
        ),
      )
      .limit(1);
    if (!hall) throw new NotFoundException('No such hall at this venue.');
    if (hall.kind !== 'hall') {
      throw new BadRequestException(`"${hall.name}" is a court, not a hall.`);
    }
    return hall;
  }
}

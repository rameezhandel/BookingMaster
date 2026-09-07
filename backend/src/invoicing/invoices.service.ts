import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DB, type Db, type Tx } from '../db/database.module';
import { customers, invoiceSeries, invoices, reservations, resources, venues } from '../db/schema';
import { PG_UNIQUE_VIOLATION } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { computeTax, financialYear, formatInvoiceNumber, stateCodeOfGstin } from './gst';

@Injectable()
export class InvoicesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /**
   * Takes the next number in a venue's series.
   *
   * The counter row is locked FOR UPDATE, so concurrent issues queue rather than
   * reading the same value. It runs on the caller's transaction on purpose: the
   * number is only spent if the invoice it belongs to commits, which is what
   * makes the series gapless. A Postgres sequence cannot do this — it hands out
   * numbers outside transaction control, so a rollback leaves a hole.
   */
  private async takeNextNumber(tx: Tx, tenantId: string, venueId: string, year: string) {
    // Create the year's counter if this is its first invoice. Doing it as an
    // upsert that does nothing on conflict means two first-invoices race
    // harmlessly instead of one failing.
    await tx
      .insert(invoiceSeries)
      .values({ tenantId, venueId, financialYear: year, nextSeq: 1 })
      .onConflictDoNothing();

    const locked = await tx.execute<{ next_seq: number }>(sql`
      SELECT next_seq FROM invoice_series
      WHERE tenant_id = ${tenantId} AND venue_id = ${venueId} AND financial_year = ${year}
      FOR UPDATE
    `);
    const seq = Number(locked.rows[0]?.next_seq);
    if (!seq) throw new Error('Invoice series row vanished while it was being locked.');

    await tx
      .update(invoiceSeries)
      .set({ nextSeq: seq + 1 })
      .where(
        and(
          eq(invoiceSeries.tenantId, tenantId),
          eq(invoiceSeries.venueId, venueId),
          eq(invoiceSeries.financialYear, year),
        ),
      );

    return seq;
  }

  /**
   * Issues a tax invoice for a booking.
   *
   * The customer's GSTIN is optional and only matters for a business claiming
   * credit; a walk-in gives a name and a phone number.
   */
  async issueForReservation(
    tenantId: string,
    reservationId: string,
    input: { customerGstin?: string; customerName?: string } = {},
  ) {
    const booking = await this.bookingForInvoice(tenantId, reservationId);
    const { venue } = booking;

    if (!venue.invoicingEnabled || !venue.gstin) {
      throw new BadRequestException(
        'This venue is not set up to issue tax invoices. Add its GSTIN in Settings first.',
      );
    }
    if (booking.reservation.status === 'cancelled') {
      throw new BadRequestException(
        'This booking was cancelled. An invoice is only issued for a booking that stands.',
      );
    }
    if (booking.reservation.kind !== 'booking') {
      throw new BadRequestException('Only a booking can be invoiced.');
    }

    const supplierState = venue.stateCode ?? stateCodeOfGstin(venue.gstin);
    const buyerState = stateCodeOfGstin(input.customerGstin) ?? supplierState;
    // The place of supply for admission to a sports facility is the venue, so
    // this is intra-state unless a business elsewhere is claiming credit.
    const intraState = buyerState === supplierState;

    const tax = computeTax({
      amountPaise: Number(booking.reservation.amountPaise),
      rateBp: venue.gstRateBp,
      inclusive: venue.pricesIncludeGst,
      intraState,
    });

    const start = DateTime.fromJSDate(booking.reservation.during.start, { zone: venue.timezone });
    const end = DateTime.fromJSDate(booking.reservation.during.end, { zone: venue.timezone });
    const year = financialYear(new Date(), venue.timezone);

    try {
      const invoice = await this.db.transaction(async (tx) => {
        const seq = await this.takeNextNumber(tx, tenantId, venue.id, year);
        const [row] = await tx
          .insert(invoices)
          .values({
            tenantId,
            venueId: venue.id,
            reservationId,
            customerId: booking.reservation.customerId,
            kind: 'invoice',
            financialYear: year,
            seq,
            number: formatInvoiceNumber(venue.invoicePrefix ?? venue.name, year, seq),
            // Snapshot: this document does not change when the venue does.
            supplierName: venue.legalName || venue.name,
            supplierGstin: venue.gstin,
            supplierAddress: venue.legalAddress || venue.address,
            supplierStateCode: supplierState,
            customerName: input.customerName || booking.customerName || 'Walk-in',
            customerPhone: booking.customerPhone,
            customerGstin: input.customerGstin?.trim().toUpperCase() || null,
            placeOfSupply: buyerState,
            sacCode: venue.sacCode,
            description:
              `${booking.courtName} — ${start.toFormat('d LLL yyyy, HH:mm')} to ${end.toFormat('HH:mm')}`,
            gstRateBp: tax.rateBp,
            taxablePaise: tax.taxablePaise,
            cgstPaise: tax.cgstPaise,
            sgstPaise: tax.sgstPaise,
            igstPaise: tax.igstPaise,
            totalPaise: tax.totalPaise,
          })
          .returning();
        return row;
      });

      await this.audit.record({
        action: 'invoice.issued',
        entityType: 'invoice',
        entityId: invoice.id,
        summary: `Issued ${invoice.number} for ${invoice.customerName}`,
        data: { totalPaise: invoice.totalPaise },
      });
      return invoice;
    } catch (err) {
      if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new ConflictException('An invoice has already been issued for this booking.');
      }
      throw err;
    }
  }

  /**
   * Reverses an invoice with a credit note.
   *
   * An issued invoice cannot be edited or deleted — the database refuses both.
   * A mistake or a cancellation is corrected by issuing the opposite document,
   * which is the legal mechanism and also the honest one: it leaves both halves
   * of what happened on the record.
   */
  async creditNoteFor(tenantId: string, invoiceId: string, reason?: string) {
    const [original] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceId)))
      .limit(1);
    if (!original) throw new NotFoundException('No such invoice.');
    if (original.kind !== 'invoice') {
      throw new BadRequestException('A credit note cannot itself be credited.');
    }

    const [venue] = await this.db
      .select()
      .from(venues)
      .where(and(eq(venues.tenantId, tenantId), eq(venues.id, original.venueId)))
      .limit(1);
    const year = financialYear(new Date(), venue?.timezone ?? 'Asia/Kolkata');

    try {
      const note = await this.db.transaction(async (tx) => {
        const seq = await this.takeNextNumber(tx, tenantId, original.venueId, year);
        const [row] = await tx
          .insert(invoices)
          .values({
            ...original,
            id: undefined,
            kind: 'credit_note',
            reversesId: original.id,
            financialYear: year,
            seq,
            number: formatInvoiceNumber(venue?.invoicePrefix ?? 'CN', year, seq),
            issuedAt: new Date(),
            description: reason?.trim()
              ? `Credit note against ${original.number} — ${reason.trim()}`
              : `Credit note against ${original.number}`,
            createdAt: undefined,
            updatedAt: undefined,
          })
          .returning();
        return row;
      });

      await this.audit.record({
        action: 'invoice.credited',
        entityType: 'invoice',
        entityId: note.id,
        summary: `Issued ${note.number} against ${original.number}`,
        data: { totalPaise: note.totalPaise },
      });
      return note;
    } catch (err) {
      if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new ConflictException('A credit note has already been issued against this invoice.');
      }
      throw err;
    }
  }

  /** The venue's documents, newest first. */
  async list(tenantId: string, venueId: string, limit = 100) {
    return this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.venueId, venueId)))
      .orderBy(desc(invoices.issuedAt))
      .limit(Math.min(limit, 500));
  }

  async get(tenantId: string, invoiceId: string) {
    const [invoice] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceId)))
      .limit(1);
    if (!invoice) throw new NotFoundException('No such invoice.');
    return invoice;
  }

  /** What has already been issued against a booking, for the booking screen. */
  async forReservation(tenantId: string, reservationId: string) {
    return this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.reservationId, reservationId)))
      .orderBy(desc(invoices.issuedAt));
  }

  private async bookingForInvoice(tenantId: string, reservationId: string) {
    const [row] = await this.db
      .select({
        reservation: reservations,
        venue: venues,
        courtName: resources.name,
        customerName: customers.name,
        customerPhone: customers.phone,
      })
      .from(reservations)
      .innerJoin(venues, eq(venues.id, reservations.venueId))
      .innerJoin(resources, eq(resources.id, reservations.resourceId))
      .leftJoin(customers, eq(customers.id, reservations.customerId))
      .where(and(eq(reservations.tenantId, tenantId), eq(reservations.id, reservationId)))
      .limit(1);
    if (!row) throw new NotFoundException('No such booking.');
    return row;
  }
}

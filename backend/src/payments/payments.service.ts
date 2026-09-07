import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DB, type Db } from '../db/database.module';
import { payments, reservations } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { formatPaise } from '../common/money';
import { paidTotals, toPaise } from '../common/paid-totals';
import { ReservationsService } from '../reservations/reservations.service';
import type { AuthUser } from '../common/current-user.decorator';
import type { CreatePaymentDto } from './dto';

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reservations: ReservationsService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, reservationId: string) {
    await this.reservations.getRaw(tenantId, reservationId);
    return this.db
      .select()
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.reservationId, reservationId)))
      .orderBy(desc(payments.receivedAt));
  }

  async create(user: AuthUser, reservationId: string, dto: CreatePaymentDto) {
    const reservation = await this.reservations.getRaw(user.tenantId, reservationId);
    if (reservation.kind === 'block') {
      throw new BadRequestException('A block cannot take a payment.');
    }

    const [payment] = await this.db
      .insert(payments)
      .values({
        tenantId: user.tenantId,
        reservationId,
        amountPaise: dto.amountPaise,
        method: dto.method,
        direction: dto.direction ?? 'in',
        reference: dto.reference,
        note: dto.note,
        receivedAt: dto.receivedAt ? new Date(dto.receivedAt) : new Date(),
        createdBy: user.id,
      })
      .returning();

    await this.audit.record({
      action: dto.direction === 'refund' ? 'payment.refunded' : 'payment.recorded',
      entityType: 'payment',
      entityId: payment.id,
      summary: `${dto.direction === 'refund' ? 'Refunded' : 'Took'} ${formatPaise(dto.amountPaise)} by ${dto.method.replace('_', ' ')}`,
      data: { reservationId, amountPaise: dto.amountPaise, method: dto.method },
    });

    return payment;
  }

  async remove(tenantId: string, paymentId: string) {
    const [payment] = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, paymentId)))
      .limit(1);
    if (!payment) throw new NotFoundException('Payment not found.');

    await this.db
      .delete(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, paymentId)));

    // Deleting a payment moves money on paper, so it is recorded loudly.
    await this.audit.record({
      action: 'payment.deleted',
      entityType: 'payment',
      entityId: paymentId,
      summary: `Deleted a ${formatPaise(Number(payment.amountPaise))} ${payment.direction === 'refund' ? 'refund' : 'payment'}`,
      data: { reservationId: payment.reservationId, method: payment.method },
    });

    return { deleted: true };
  }

  /** Net collected against a booking: money in, less refunds. */
  async balanceFor(tenantId: string, reservationId: string) {
    const paid = paidTotals(this.db);
    const [row] = await this.db
      .select({ amountPaise: reservations.amountPaise, paidPaise: paid.paidPaise })
      .from(reservations)
      .leftJoin(paid, eq(paid.reservationId, reservations.id))
      .where(and(eq(reservations.tenantId, tenantId), eq(reservations.id, reservationId)))
      .limit(1);
    if (!row) throw new NotFoundException('Booking not found.');

    const amountPaise = toPaise(row.amountPaise);
    const paidPaise = toPaise(row.paidPaise);
    return { amountPaise, paidPaise, duePaise: amountPaise - paidPaise };
  }
}

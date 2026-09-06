import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { DB, type Db, type DbExecutor } from '../db/database.module';
import { customers, reservations, resources } from '../db/schema';
import { rethrowAsHttp } from '../common/errors';
import { normalisePhone, type CreateCustomerDto, type CustomerRefDto, type UpdateCustomerDto } from './dto';

@Injectable()
export class CustomersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list(tenantId: string, query?: string, limit = 50) {
    const where = query?.trim()
      ? and(
          eq(customers.tenantId, tenantId),
          or(ilike(customers.name, `%${query.trim()}%`), ilike(customers.phone, `%${query.trim()}%`)),
        )
      : eq(customers.tenantId, tenantId);

    return this.db
      .select()
      .from(customers)
      .where(where)
      .orderBy(desc(customers.updatedAt))
      .limit(Math.min(limit, 200));
  }

  async get(tenantId: string, customerId: string) {
    const [customer] = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
      .limit(1);
    if (!customer) throw new NotFoundException('Customer not found.');
    return customer;
  }

  /** Customer detail plus their booking history — the "is this a regular?" view. */
  async getWithHistory(tenantId: string, customerId: string) {
    const customer = await this.get(tenantId, customerId);
    const history = await this.db
      .select({
        id: reservations.id,
        during: reservations.during,
        status: reservations.status,
        amountPaise: reservations.amountPaise,
        resourceName: resources.name,
        sport: resources.sport,
      })
      .from(reservations)
      .innerJoin(resources, eq(resources.id, reservations.resourceId))
      .where(and(eq(reservations.tenantId, tenantId), eq(reservations.customerId, customerId)))
      .orderBy(desc(sql`lower(${reservations.during})`))
      .limit(100);

    return { ...customer, history };
  }

  async create(tenantId: string, dto: CreateCustomerDto) {
    try {
      const [customer] = await this.db
        .insert(customers)
        .values({ tenantId, name: dto.name, phone: normalisePhone(dto.phone), notes: dto.notes })
        .returning();
      return customer;
    } catch (err) {
      rethrowAsHttp(err);
    }
  }

  async update(tenantId: string, customerId: string, dto: UpdateCustomerDto) {
    await this.get(tenantId, customerId);
    try {
      const [customer] = await this.db
        .update(customers)
        .set({ ...dto, ...(dto.phone ? { phone: normalisePhone(dto.phone) } : {}) })
        .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
        .returning();
      return customer;
    } catch (err) {
      rethrowAsHttp(err);
    }
  }

  /**
   * Quick-book takes a name and a phone, not a customer id: the owner is on the
   * phone with someone and should not have to decide whether they are new.
   * Upsert on (tenant, phone) keeps that a single round trip and race-free.
   */
  async findOrCreate(exec: DbExecutor, tenantId: string, ref: CustomerRefDto) {
    const phone = normalisePhone(ref.phone);
    const [customer] = await exec
      .insert(customers)
      .values({ tenantId, name: ref.name, phone })
      .onConflictDoUpdate({
        target: [customers.tenantId, customers.phone],
        set: { name: ref.name },
      })
      .returning();
    return customer;
  }
}

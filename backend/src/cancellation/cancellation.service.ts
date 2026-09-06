import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DB, type Db } from '../db/database.module';
import { cancellationTiers } from '../db/schema';
import { VenuesService } from '../venues/venues.service';
import type { CancellationTierDto } from './dto';
import type { CancellationTier } from './resolve';

@Injectable()
export class CancellationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly venues: VenuesService,
  ) {}

  async list(tenantId: string, venueId: string) {
    await this.venues.get(tenantId, venueId);
    return this.tiersFor(tenantId, venueId);
  }

  /** Ordered most generous first, which is also how an owner reads the ladder. */
  async tiersFor(tenantId: string, venueId: string): Promise<CancellationTier[]> {
    const rows = await this.db
      .select({
        minHoursBefore: cancellationTiers.minHoursBefore,
        refundPct: cancellationTiers.refundPct,
      })
      .from(cancellationTiers)
      .where(and(eq(cancellationTiers.tenantId, tenantId), eq(cancellationTiers.venueId, venueId)))
      .orderBy(asc(cancellationTiers.minHoursBefore));
    return rows.sort((a, b) => b.minHoursBefore - a.minHoursBefore);
  }

  async replace(tenantId: string, venueId: string, tiers: CancellationTierDto[]) {
    await this.venues.get(tenantId, venueId);

    const thresholds = new Set(tiers.map((t) => t.minHoursBefore));
    if (thresholds.size !== tiers.length) {
      throw new BadRequestException('Two rules cannot share the same number of hours.');
    }

    // A ladder where a later cancellation refunds *more* is almost certainly a
    // mistake, and it would be invisible until a customer noticed.
    const ordered = [...tiers].sort((a, b) => b.minHoursBefore - a.minHoursBefore);
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].refundPct > ordered[i - 1].refundPct) {
        throw new BadRequestException(
          `Cancelling later should not refund more: ${ordered[i].minHoursBefore}h gives ${ordered[i].refundPct}% but ${ordered[i - 1].minHoursBefore}h gives ${ordered[i - 1].refundPct}%.`,
        );
      }
    }

    return this.db.transaction(async (tx) => {
      await tx
        .delete(cancellationTiers)
        .where(and(eq(cancellationTiers.tenantId, tenantId), eq(cancellationTiers.venueId, venueId)));

      if (tiers.length === 0) return [];

      return tx
        .insert(cancellationTiers)
        .values(
          tiers.map((t) => ({
            tenantId,
            venueId,
            minHoursBefore: t.minHoursBefore,
            refundPct: t.refundPct,
          })),
        )
        .returning();
    });
  }
}

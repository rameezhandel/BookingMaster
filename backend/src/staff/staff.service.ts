import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { DateTime } from 'luxon';
import { DB, type Db } from '../db/database.module';
import { runAsSystem } from '../db/run-as-tenant';
import { staffInvites, tenants, users } from '../db/schema';
import { PG_UNIQUE_VIOLATION } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import type { AcceptInviteDto, InviteStaffDto, UpdateStaffDto } from './dto';

const BCRYPT_ROUNDS = 12;
const INVITE_TTL_DAYS = 7;

/** Hashed, never stored raw — a leaked backup must not hand out working invites. */
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class StaffService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Everyone with a login here, including the ones switched off. */
  async list(tenantId: string) {
    return this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        isActive: users.isActive,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.tenantId, tenantId))
      .orderBy(desc(users.isActive), users.createdAt);
  }

  /** Invitations still waiting to be taken up. */
  async pendingInvites(tenantId: string) {
    return this.db
      .select({
        id: staffInvites.id,
        email: staffInvites.email,
        name: staffInvites.name,
        role: staffInvites.role,
        expiresAt: staffInvites.expiresAt,
        createdAt: staffInvites.createdAt,
      })
      .from(staffInvites)
      .where(
        and(
          eq(staffInvites.tenantId, tenantId),
          isNull(staffInvites.acceptedAt),
          isNull(staffInvites.revokedAt),
          sql`${staffInvites.expiresAt} > now()`,
        ),
      )
      .orderBy(desc(staffInvites.createdAt));
  }

  /**
   * Invites someone by email.
   *
   * The owner never sets anyone else's password. They name the person and the
   * person sets their own, so it is known to nobody else and never travels
   * through a chat message — which is where shared logins usually start.
   */
  async invite(tenantId: string, actorId: string, dto: InviteStaffDto) {
    const email = dto.email.trim().toLowerCase();

    // Email is the login and is unique across the whole system, so a clash may
    // be with someone in another tenant entirely. Say the same thing either
    // way: whether an address has an account elsewhere is not this owner's
    // business.
    const taken = await runAsSystem(this.db, async () => {
      const [row] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`)
        .limit(1);
      return row;
    });
    if (taken) {
      throw new ConflictException('That email address already has a login.');
    }

    const token = randomBytes(32).toString('base64url');
    try {
      const [invite] = await this.db
        .insert(staffInvites)
        .values({
          tenantId,
          email,
          name: dto.name.trim(),
          role: dto.role ?? 'staff',
          tokenHash: hashToken(token),
          invitedBy: actorId,
          expiresAt: DateTime.now().plus({ days: INVITE_TTL_DAYS }).toJSDate(),
        })
        .returning();

      await this.audit.record({
        action: 'staff.invited',
        entityType: 'staff_invite',
        entityId: invite.id,
        summary: `Invited ${email} as ${invite.role}`,
      });

      // The token is returned once, here, and never again: only its hash is
      // stored. The owner passes on the link.
      return { ...invite, token, tokenHash: undefined };
    } catch (err) {
      if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new ConflictException(
          'There is already an invitation waiting for that address. Revoke it first to send another.',
        );
      }
      throw err;
    }
  }

  async revokeInvite(tenantId: string, inviteId: string) {
    const [invite] = await this.db
      .update(staffInvites)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(staffInvites.tenantId, tenantId),
          eq(staffInvites.id, inviteId),
          isNull(staffInvites.acceptedAt),
          isNull(staffInvites.revokedAt),
        ),
      )
      .returning({ id: staffInvites.id, email: staffInvites.email });
    if (!invite) throw new NotFoundException('That invitation is no longer open.');

    await this.audit.record({
      action: 'staff.invite_revoked',
      entityType: 'staff_invite',
      entityId: invite.id,
      summary: `Revoked the invitation to ${invite.email}`,
    });
    return { revoked: true };
  }

  /**
   * What an invitation link shows before anyone types a password.
   *
   * Unauthenticated by necessity — the person has no login yet — so it reveals
   * only what they already know from the email that brought them here.
   */
  async describeInvite(token: string) {
    const invite = await this.findLiveInvite(token);
    const [tenant] = await runAsSystem(this.db, () =>
      this.db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, invite.tenantId)).limit(1),
    );
    return { email: invite.email, name: invite.name, role: invite.role, business: tenant?.name ?? null };
  }

  /**
   * Redeems an invitation, creating the login.
   *
   * Single-use: the invite is marked accepted in the same transaction that
   * creates the user, so two taps on the link cannot make two accounts.
   */
  async accept(dto: AcceptInviteDto) {
    const invite = await this.findLiveInvite(dto.token);
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    return runAsSystem(this.db, async () => {
      return this.db.transaction(async (tx) => {
        // Spend the invitation first. Conditioned on it still being open, so
        // the loser of a race gets nothing rather than a second account.
        const [spent] = await tx
          .update(staffInvites)
          .set({ acceptedAt: new Date() })
          .where(
            and(
              eq(staffInvites.id, invite.id),
              isNull(staffInvites.acceptedAt),
              isNull(staffInvites.revokedAt),
            ),
          )
          .returning({ id: staffInvites.id });
        if (!spent) throw new BadRequestException('That invitation has already been used.');

        let created;
        try {
          [created] = await tx
            .insert(users)
            .values({
              tenantId: invite.tenantId,
              email: invite.email,
              passwordHash,
              name: dto.name?.trim() || invite.name,
              role: invite.role,
            })
            .returning();
        } catch (err) {
          if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
            throw new ConflictException('That email address already has a login.');
          }
          throw err;
        }

        await tx
          .update(staffInvites)
          .set({ acceptedUser: created.id })
          .where(eq(staffInvites.id, invite.id));

        return created;
      });
    });
  }

  /**
   * Changes someone's role, or switches their login off.
   *
   * Deactivation rather than deletion: their bookings, payments and audit trail
   * all point at them, and removing the row would either take that history with
   * it or leave it anonymous.
   */
  async update(tenantId: string, actorId: string, userId: string, dto: UpdateStaffDto) {
    const [target] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
      .limit(1);
    if (!target) throw new NotFoundException('No such person on this account.');

    // Locking yourself out needs someone else to let you back in, and on a
    // one-owner account there is nobody.
    if (userId === actorId) {
      if (dto.isActive === false) {
        throw new BadRequestException('You cannot switch off your own login.');
      }
      if (dto.role && dto.role !== target.role) {
        throw new BadRequestException('You cannot change your own role.');
      }
    }

    // An account with no active owner cannot be administered by anyone.
    const losingAnOwner =
      target.role === 'owner' && (dto.isActive === false || (dto.role && dto.role !== 'owner'));
    if (losingAnOwner) {
      const [{ value: others }] = await this.db
        .select({ value: count() })
        .from(users)
        .where(
          and(
            eq(users.tenantId, tenantId),
            eq(users.role, 'owner'),
            eq(users.isActive, true),
            ne(users.id, userId),
          ),
        );
      if (others === 0) {
        throw new BadRequestException(
          'This is the last active owner. Make someone else an owner first.',
        );
      }
    }

    const [updated] = await this.db
      .update(users)
      .set({
        ...(dto.role ? { role: dto.role } : {}),
        ...(dto.isActive === undefined
          ? {}
          : { isActive: dto.isActive, deactivatedAt: dto.isActive ? null : new Date() }),
      })
      .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
      .returning({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        isActive: users.isActive,
      });

    if (dto.isActive !== undefined && dto.isActive !== target.isActive) {
      await this.audit.record({
        action: dto.isActive ? 'staff.reactivated' : 'staff.deactivated',
        entityType: 'app_user',
        entityId: userId,
        summary: `${dto.isActive ? 'Restored' : 'Switched off'} the login for ${target.email}`,
      });
    }
    if (dto.role && dto.role !== target.role) {
      await this.audit.record({
        action: 'staff.role_changed',
        entityType: 'app_user',
        entityId: userId,
        summary: `${target.email} is now ${dto.role}`,
      });
    }

    return updated;
  }

  /**
   * An invitation that is still good, or a single unhelpful error.
   *
   * Expired, revoked, already used and never existed all answer the same way:
   * a token is a secret, and distinguishing the cases turns this into an oracle
   * for guessing them.
   */
  private async findLiveInvite(token: string) {
    const [invite] = await runAsSystem(this.db, () =>
      this.db
        .select()
        .from(staffInvites)
        .where(eq(staffInvites.tokenHash, hashToken(token)))
        .limit(1),
    );

    if (
      !invite ||
      invite.acceptedAt ||
      invite.revokedAt ||
      invite.expiresAt.getTime() <= Date.now()
    ) {
      throw new NotFoundException('This invitation is no longer valid. Ask for a new one.');
    }
    return invite;
  }
}

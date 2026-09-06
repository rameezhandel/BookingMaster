import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/database.module';
import { tenants, users } from '../db/schema';
import { rethrowAsHttp } from '../common/errors';
import type { AuthUser } from '../common/current-user.decorator';
import type { JwtPayload } from './jwt.strategy';
import type { LoginDto, RegisterDto } from './dto';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    try {
      // Tenant and its first owner are created together or not at all.
      const user = await this.db.transaction(async (tx) => {
        const [tenant] = await tx.insert(tenants).values({ name: dto.businessName }).returning();
        const [created] = await tx
          .insert(users)
          .values({
            tenantId: tenant.id,
            email: dto.email.trim().toLowerCase(),
            passwordHash,
            name: dto.name,
            role: 'owner',
          })
          .returning();
        return created;
      });
      return this.issue(user);
    } catch (err) {
      rethrowAsHttp(err);
    }
  }

  async login(dto: LoginDto) {
    const [user] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${dto.email.trim().toLowerCase()}`)
      .limit(1);

    // Compare against a dummy hash when the user is missing so that a wrong
    // email and a wrong password take the same amount of time.
    const hash = user?.passwordHash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const ok = await bcrypt.compare(dto.password, hash);
    if (!user || !ok) throw new UnauthorizedException('Incorrect email or password.');

    return this.issue(user);
  }

  async me(auth: AuthUser) {
    const [user] = await this.db.select().from(users).where(eq(users.id, auth.id)).limit(1);
    if (!user) throw new UnauthorizedException();
    const [tenant] = await this.db.select().from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenant: { id: tenant.id, name: tenant.name },
    };
  }

  private issue(user: typeof users.$inferSelect) {
    const payload: JwtPayload = {
      sub: user.id,
      tid: user.tenantId,
      email: user.email,
      name: user.name,
      role: user.role,
    };
    return {
      token: this.jwt.sign(payload),
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  }
}

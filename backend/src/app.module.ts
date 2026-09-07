import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AvailabilityModule } from './availability/availability.module';
import { CalendarModule } from './calendar/calendar.module';
import { CancellationModule } from './cancellation/cancellation.module';
import { validateEnv } from './config/env.validation';
import { CustomersModule } from './customers/customers.module';
import { DatabaseModule } from './db/database.module';
import { TenantContextInterceptor } from './db/tenant.interceptor';
import { HealthModule } from './health/health.module';
import { PaymentsModule } from './payments/payments.module';
import { PricingModule } from './pricing/pricing.module';
import { PublicModule } from './public/public.module';
import { ReportsModule } from './reports/reports.module';
import { ReservationsModule } from './reservations/reservations.module';
import { SeriesModule } from './series/series.module';
import { VenuesModule } from './venues/venues.module';

/**
 * In production the API also serves the built web bundle, so the whole thing is
 * one origin and one deployable: no CORS in the request path, no second service
 * to keep in sync, and relative /api calls just work.
 *
 * In development the bundle does not exist and Vite serves it instead, so this
 * is registered only when there is something to serve.
 */
function webApp(): DynamicModule[] {
  const rootPath = process.env.WEB_DIST
    ? resolve(process.env.WEB_DIST)
    : join(__dirname, '..', '..', 'frontend', 'dist');

  if (!existsSync(join(rootPath, 'index.html'))) return [];

  return [
    ServeStaticModule.forRoot({
      rootPath,
      // Everything under /api stays with the controllers; any other path falls
      // through to index.html so client-side routes survive a hard refresh.
      exclude: ['/api*'],
    }),
  ];
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // A blunt ceiling on request volume per IP. The strict limit that actually
    // matters is on the auth routes; see AuthController.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuditModule,
    HealthModule,
    AuthModule,
    VenuesModule,
    AvailabilityModule,
    PricingModule,
    CustomersModule,
    CancellationModule,
    ReservationsModule,
    PublicModule,
    SeriesModule,
    PaymentsModule,
    CalendarModule,
    ReportsModule,
    ...webApp(),
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Runs after the auth guard, so req.user is populated by the time the
    // tenant is read off it.
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { CalendarModule } from './calendar/calendar.module';
import { CustomersModule } from './customers/customers.module';
import { DatabaseModule } from './db/database.module';
import { PaymentsModule } from './payments/payments.module';
import { PricingModule } from './pricing/pricing.module';
import { ReportsModule } from './reports/reports.module';
import { ReservationsModule } from './reservations/reservations.module';
import { VenuesModule } from './venues/venues.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    VenuesModule,
    PricingModule,
    CustomersModule,
    ReservationsModule,
    PaymentsModule,
    CalendarModule,
    ReportsModule,
  ],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { CancellationModule } from '../cancellation/cancellation.module';
import { CustomersModule } from '../customers/customers.module';
import { PricingModule } from '../pricing/pricing.module';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [CustomersModule, PricingModule, AvailabilityModule, CancellationModule],
  controllers: [ReservationsController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}

import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { PricingModule } from '../pricing/pricing.module';
import { VenuesModule } from '../venues/venues.module';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';

@Module({
  imports: [VenuesModule, PricingModule, AvailabilityModule],
  controllers: [CalendarController],
  providers: [CalendarService],
})
export class CalendarModule {}

import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module';
import { VenuesModule } from '../venues/venues.module';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';

@Module({
  imports: [VenuesModule, PricingModule],
  controllers: [CalendarController],
  providers: [CalendarService],
})
export class CalendarModule {}

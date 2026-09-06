import { Module } from '@nestjs/common';
import { VenuesModule } from '../venues/venues.module';
import { HoursController } from './hours.controller';
import { HoursService } from './hours.service';

@Module({
  imports: [VenuesModule],
  controllers: [HoursController],
  providers: [HoursService],
  exports: [HoursService],
})
export class AvailabilityModule {}

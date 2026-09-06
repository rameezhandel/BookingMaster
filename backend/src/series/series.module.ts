import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { CustomersModule } from '../customers/customers.module';
import { PricingModule } from '../pricing/pricing.module';
import { SeriesController } from './series.controller';
import { SeriesScheduler } from './series.scheduler';
import { SeriesService } from './series.service';

@Module({
  imports: [CustomersModule, PricingModule, AvailabilityModule],
  controllers: [SeriesController],
  providers: [SeriesService, SeriesScheduler],
  exports: [SeriesService],
})
export class SeriesModule {}

import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { PricingModule } from '../pricing/pricing.module';
import { PublicController } from './public.controller';
import { PublicService } from './public.service';

@Module({
  imports: [AvailabilityModule, PricingModule],
  controllers: [PublicController],
  providers: [PublicService],
  exports: [PublicService],
})
export class PublicModule {}

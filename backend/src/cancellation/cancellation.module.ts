import { Module } from '@nestjs/common';
import { VenuesModule } from '../venues/venues.module';
import { CancellationController } from './cancellation.controller';
import { CancellationService } from './cancellation.service';

@Module({
  imports: [VenuesModule],
  controllers: [CancellationController],
  providers: [CancellationService],
  exports: [CancellationService],
})
export class CancellationModule {}

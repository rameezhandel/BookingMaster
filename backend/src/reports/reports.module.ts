import { Module } from '@nestjs/common';
import { VenuesModule } from '../venues/venues.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [VenuesModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}

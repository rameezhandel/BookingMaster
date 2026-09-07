import { Controller, Get, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { ReportsService } from './reports.service';

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('summary')
  summary(
    @CurrentUser() user: AuthUser,
    @Query('venueId', ParseUUIDPipe) venueId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.reports.summary(user.tenantId, venueId, from, to);
  }
}

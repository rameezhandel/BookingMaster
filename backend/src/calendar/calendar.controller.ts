import { Controller, Get, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { CalendarService } from './calendar.service';

@Controller('calendar')
@UseGuards(JwtAuthGuard)
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get()
  day(
    @CurrentUser() user: AuthUser,
    @Query('venueId', ParseUUIDPipe) venueId: string,
    @Query('date') date: string,
  ) {
    return this.calendar.day(user.tenantId, venueId, date);
  }

  @Get('week')
  week(
    @CurrentUser() user: AuthUser,
    @Query('venueId', ParseUUIDPipe) venueId: string,
    @Query('date') date: string,
  ) {
    return this.calendar.week(user.tenantId, venueId, date);
  }
}

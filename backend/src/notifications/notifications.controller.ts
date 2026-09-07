import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { NotificationsService } from './notifications.service';

@Controller('venues/:id/messages')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** What was sent to whom, so an owner can answer "did they get it?". */
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) venueId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.notifications.list(user.tenantId, venueId, limit);
  }
}

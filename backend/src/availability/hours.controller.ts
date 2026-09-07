import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OwnerOnly } from '../auth/roles.guard';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { CreateOverrideDto, ListOverridesDto, SetHoursDto } from './dto';
import { HoursService } from './hours.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class HoursController {
  constructor(private readonly hours: HoursService) {}

  @Get('resources/:id/hours')
  list(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.hours.list(user.tenantId, id);
  }

  /*
   * Weekly hours are configuration and stay with the owner; a one-off closure
   * below does not.
   *
   * "The turf is flooded, we are shut this evening" is something the person at
   * the desk knows and the owner, who is not there, does not. Staff can already
   * block a court for rain — a venue-wide closure is the same act at a
   * different size, and allowing one but not the other only teaches people to
   * borrow the owner's login.
   */
  @OwnerOnly()
  @Put('resources/:id/hours')
  replace(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetHoursDto,
  ) {
    return this.hours.replace(user.tenantId, id, dto.windows);
  }

  @Get('venues/:id/overrides')
  listOverrides(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListOverridesDto,
  ) {
    return this.hours.listOverrides(user.tenantId, id, query);
  }

  @Post('venues/:id/overrides')
  createOverride(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateOverrideDto,
  ) {
    return this.hours.createOverride(user.tenantId, id, dto);
  }

  @Delete('overrides/:id')
  removeOverride(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.hours.removeOverride(user.tenantId, id);
  }
}

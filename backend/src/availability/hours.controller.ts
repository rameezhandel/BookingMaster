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

  @OwnerOnly()
  @Post('venues/:id/overrides')
  createOverride(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateOverrideDto,
  ) {
    return this.hours.createOverride(user.tenantId, id, dto);
  }

  @OwnerOnly()
  @Delete('overrides/:id')
  removeOverride(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.hours.removeOverride(user.tenantId, id);
  }
}

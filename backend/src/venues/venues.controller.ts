import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OwnerOnly } from '../auth/roles.guard';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { CreateResourceDto, CreateVenueDto, UpdateResourceDto, UpdateVenueDto } from './dto';
import { VenuesService } from './venues.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class VenuesController {
  constructor(private readonly venues: VenuesService) {}

  @Get('venues')
  list(@CurrentUser() user: AuthUser) {
    return this.venues.list(user.tenantId);
  }

  @OwnerOnly()
  @Post('venues')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateVenueDto) {
    return this.venues.create(user.tenantId, dto);
  }

  @Get('venues/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.venues.get(user.tenantId, id);
  }

  @OwnerOnly()
  @Patch('venues/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVenueDto,
  ) {
    return this.venues.update(user.tenantId, id, dto);
  }

  @Get('venues/:id/resources')
  listResources(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('includeInactive', new ParseBoolPipe({ optional: true })) includeInactive?: boolean,
  ) {
    return this.venues.listResources(user.tenantId, id, includeInactive ?? false);
  }

  @OwnerOnly()
  @Post('venues/:id/resources')
  createResource(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateResourceDto,
  ) {
    return this.venues.createResource(user.tenantId, id, dto);
  }

  @OwnerOnly()
  @Patch('resources/:id')
  updateResource(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateResourceDto,
  ) {
    return this.venues.updateResource(user.tenantId, id, dto);
  }

  @OwnerOnly()
  @Delete('resources/:id')
  deleteResource(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.venues.deleteResource(user.tenantId, id);
  }
}

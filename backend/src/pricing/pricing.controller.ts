import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OwnerOnly } from '../auth/roles.guard';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { CreatePriceRuleDto, UpdatePriceRuleDto } from './dto';
import { PricingService } from './pricing.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get('resources/:id/price-rules')
  list(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.pricing.list(user.tenantId, id);
  }

  @OwnerOnly()
  @Post('resources/:id/price-rules')
  create(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePriceRuleDto,
  ) {
    return this.pricing.create(user.tenantId, id, dto);
  }

  @OwnerOnly()
  @Patch('price-rules/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePriceRuleDto,
  ) {
    return this.pricing.update(user.tenantId, id, dto);
  }

  @OwnerOnly()
  @Delete('price-rules/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.pricing.remove(user.tenantId, id);
  }

  @Get('pricing/quote')
  quote(
    @CurrentUser() user: AuthUser,
    @Query('resourceId', ParseUUIDPipe) resourceId: string,
    @Query('start') start: string,
    @Query('end') end: string,
  ) {
    const interval = { start: new Date(start), end: new Date(end) };
    if (Number.isNaN(interval.start.getTime()) || Number.isNaN(interval.end.getTime())) {
      throw new BadRequestException('start and end must be ISO-8601 timestamps.');
    }
    if (interval.end <= interval.start) {
      throw new BadRequestException('end must be after start.');
    }
    return this.pricing.quote(user.tenantId, resourceId, interval);
  }
}

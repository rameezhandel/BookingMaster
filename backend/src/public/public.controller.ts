import { Controller, Get, Param, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PublicService } from './public.service';

/**
 * Unauthenticated. Everything here is readable by anyone with the venue's
 * public address, so each response is built from an explicit column list rather
 * than by stripping fields off an internal shape.
 */
@Controller('public/venues')
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class PublicController {
  constructor(private readonly publicService: PublicService) {}

  @Get(':slug')
  venue(@Param('slug') slug: string) {
    return this.publicService.venue(slug);
  }

  @Get(':slug/availability')
  availability(@Param('slug') slug: string, @Query('date') date: string) {
    return this.publicService.availability(slug, date);
  }
}

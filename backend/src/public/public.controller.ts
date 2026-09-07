import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentCustomer, CustomerAuthGuard, type CustomerUser } from './customer-auth';
import { CreateHoldDto, RequestOtpDto, VerifyOtpDto } from './dto';
import { PublicBookingService } from './public-booking.service';
import { PublicService } from './public.service';

/**
 * Unauthenticated. Everything here is readable by anyone with the venue's
 * public address, so each response is built from an explicit column list rather
 * than by stripping fields off an internal shape.
 */
@Controller('public/venues')
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class PublicController {
  constructor(
    private readonly publicService: PublicService,
    private readonly booking: PublicBookingService,
  ) {}

  @Get(':slug')
  venue(@Param('slug') slug: string) {
    return this.publicService.venue(slug);
  }

  @Get(':slug/availability')
  availability(@Param('slug') slug: string, @Query('date') date: string) {
    return this.publicService.availability(slug, date);
  }

  // Sending codes costs money and annoys strangers, so this budget is far
  // tighter than the general public one. The service adds a per-number
  // cooldown on top.
  @Post(':slug/otp/request')
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  requestOtp(@Param('slug') slug: string, @Body() dto: RequestOtpDto) {
    return this.booking.requestOtp(slug, dto);
  }

  @Post(':slug/otp/verify')
  @Throttle({ default: { limit: 10, ttl: 300_000 } })
  verifyOtp(@Param('slug') slug: string, @Body() dto: VerifyOtpDto) {
    return this.booking.verifyOtp(slug, dto);
  }
}

@Controller('public')
@UseGuards(CustomerAuthGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class PublicBookingController {
  constructor(private readonly booking: PublicBookingService) {}

  @Post('holds')
  hold(@CurrentCustomer() user: CustomerUser, @Body() dto: CreateHoldDto) {
    return this.booking.hold(user, dto);
  }

  @Post('holds/:id/confirm')
  confirm(@CurrentCustomer() user: CustomerUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.booking.confirm(user, id);
  }

  @Delete('holds/:id')
  release(@CurrentCustomer() user: CustomerUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.booking.release(user, id);
  }

  @Get('my/bookings')
  mine(@CurrentCustomer() user: CustomerUser) {
    return this.booking.mine(user);
  }
}

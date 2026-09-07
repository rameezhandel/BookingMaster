import {
  Body,
  Controller,
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
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { BookEnquiryDto, CreateEnquiryDto, UpdateEnquiryDto } from './dto';
import { EnquiriesService } from './enquiries.service';

/**
 * Hall enquiries.
 *
 * Open to staff throughout: taking an enquiry, booking a site visit and holding
 * a date are what the person at the desk does all day. Nothing here is
 * owner-only — the money decisions are in the price on the booking, and those
 * already have their own rules.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class EnquiriesController {
  constructor(private readonly enquiries: EnquiriesService) {}

  @Get('venues/:id/enquiries')
  list(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) venueId: string,
    @Query('status') status?: string,
    @Query('includeClosed', new ParseBoolPipe({ optional: true })) includeClosed?: boolean,
  ) {
    return this.enquiries.list(user.tenantId, venueId, { status, includeClosed });
  }

  @Post('venues/:id/enquiries')
  create(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) venueId: string,
    @Body() dto: CreateEnquiryDto,
  ) {
    return this.enquiries.create(user.tenantId, venueId, dto);
  }

  /** Which dates each hall is already spoken for — "is the 14th free?". */
  @Get('venues/:id/halls/availability')
  availability(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) venueId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.enquiries.availability(user.tenantId, venueId, from, to);
  }

  @Get('enquiries/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.enquiries.get(user.tenantId, id);
  }

  @Patch('enquiries/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEnquiryDto,
  ) {
    return this.enquiries.update(user.tenantId, id, dto);
  }

  /** The one place an enquiry touches the calendar. */
  @Post('enquiries/:id/book')
  book(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BookEnquiryDto,
  ) {
    return this.enquiries.book(user.tenantId, id, dto);
  }
}

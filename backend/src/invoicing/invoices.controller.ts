import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OwnerOnly } from '../auth/roles.guard';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { CreditNoteDto, IssueInvoiceDto } from './dto';
import { InvoicesService } from './invoices.service';

/**
 * Tax documents. Owner-only: an invoice is a statement about the business's
 * money made in the business's name, and it cannot be taken back once issued.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @OwnerOnly()
  @Get('venues/:id/invoices')
  list(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) venueId: string,
    @Query('limit') limit?: string,
  ) {
    return this.invoices.list(user.tenantId, venueId, limit ? Number(limit) : 100);
  }

  @OwnerOnly()
  @Get('invoices/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.get(user.tenantId, id);
  }

  /** What has already been issued against a booking, for the booking screen. */
  @Get('reservations/:id/invoices')
  forReservation(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.forReservation(user.tenantId, id);
  }

  @OwnerOnly()
  @Post('reservations/:id/invoice')
  issue(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IssueInvoiceDto,
  ) {
    return this.invoices.issueForReservation(user.tenantId, id, dto);
  }

  @OwnerOnly()
  @Post('invoices/:id/credit-note')
  credit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreditNoteDto,
  ) {
    return this.invoices.creditNoteFor(user.tenantId, id, dto.reason);
  }
}

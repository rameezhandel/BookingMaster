import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { GSTIN_RE } from './gst';

export class IssueInvoiceDto {
  /** Supplied when a business wants the invoice in its own name for credit. */
  @IsOptional()
  @Matches(GSTIN_RE, { message: 'That does not look like a GSTIN.' })
  customerGstin?: string;

  /** A business name, which is often not the name the booking was made under. */
  @IsOptional() @IsString() @MaxLength(160) customerName?: string;
}

export class CreditNoteDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

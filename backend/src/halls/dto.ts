import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsISO8601,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const PHONE_RE = /^[+0-9][0-9 \-()]{6,19}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateEnquiryDto {
  @IsString() @MinLength(1) @MaxLength(160) contactName: string;
  @Matches(PHONE_RE, { message: 'Enter a valid phone number.' }) contactPhone: string;
  @IsOptional() @IsString() @MaxLength(254) contactEmail?: string;

  @IsOptional() @IsUUID() resourceId?: string;
  @IsOptional() @IsString() @MaxLength(60) eventType?: string;
  /** Left out while it is still "sometime in November". */
  @IsOptional() @Matches(DATE_RE, { message: 'Use YYYY-MM-DD.' }) eventDate?: string;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) guestCount?: number;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateEnquiryDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) contactName?: string;
  @IsOptional() @Matches(PHONE_RE, { message: 'Enter a valid phone number.' }) contactPhone?: string;
  @IsOptional() @IsString() @MaxLength(254) contactEmail?: string;
  @IsOptional() @IsUUID() resourceId?: string;
  @IsOptional() @IsString() @MaxLength(60) eventType?: string;
  @IsOptional() @Matches(DATE_RE, { message: 'Use YYYY-MM-DD.' }) eventDate?: string;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) guestCount?: number;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;

  @IsOptional() @IsIn(['new', 'visit_scheduled', 'quoted', 'lost']) status?:
    | 'new'
    | 'visit_scheduled'
    | 'quoted'
    | 'lost';
  @IsOptional() @IsISO8601() visitAt?: string;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) quotedPaise?: number;
  @IsOptional() @IsString() @MaxLength(300) lostReason?: string;
}

/**
 * Turning an enquiry into something that actually blocks the date.
 *
 * A hold is tentative and expires; a confirmation does not. Both take the same
 * shape because they describe the same event — only their permanence differs.
 */
export class BookEnquiryDto {
  @IsUUID() resourceId: string;

  /** When the event itself runs. */
  @IsISO8601() eventStart: string;
  @IsISO8601() eventEnd: string;

  /**
   * When the hall is actually unavailable to anyone else — the decorator wants
   * it the evening before. Defaults to the event window when not given.
   */
  @IsOptional() @IsISO8601() accessStart?: string;
  @IsOptional() @IsISO8601() accessEnd?: string;

  @IsOptional() @IsInt() @Min(0) @Type(() => Number) amountPaise?: number;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;

  /**
   * A tentative hold rather than a confirmed booking, released on this date if
   * they do not commit. Days, not minutes: a family deciding on a wedding venue
   * is not going to do it inside ten.
   */
  @IsOptional() @IsBoolean() tentative?: boolean;
  @IsOptional() @Matches(DATE_RE, { message: 'Use YYYY-MM-DD.' }) holdUntil?: string;
}

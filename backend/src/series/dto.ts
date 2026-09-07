import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CustomerRefDto } from '../customers/dto';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export class CreateSeriesDto {
  @IsUUID() resourceId: string;

  /** 0 = Sunday .. 6 = Saturday. */
  @IsInt() @Min(0) @Max(6) @Type(() => Number) dayOfWeek: number;
  @Matches(TIME_RE, { message: 'startsAt must be HH:MM' }) startsAt: string;
  @IsInt() @Min(15) @Max(1440) @Type(() => Number) durationMinutes: number;

  @IsISO8601() startsOn: string;
  /** Omit for an open-ended series that the nightly job keeps rolling forward. */
  @IsOptional() @IsISO8601() endsOn?: string;

  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @ValidateNested() @Type(() => CustomerRefDto) customer?: CustomerRefDto;

  /** Omit to price every occurrence from the price rules as it is created. */
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) amountPaise?: number;

  @IsOptional() @IsString() @MaxLength(1000) notes?: string;

  /** How far ahead to create bookings now. */
  @IsOptional() @IsInt() @Min(1) @Max(52) @Type(() => Number) weeks?: number;
}

export class UpdateSeriesDto {
  @IsOptional() @IsISO8601() endsOn?: string;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) amountPaise?: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class ExtendSeriesDto {
  @IsOptional() @IsInt() @Min(1) @Max(52) @Type(() => Number) weeks?: number;
}

export class EndSeriesDto {
  /**
   * Cancel occurrences from this date onward. Defaults to today, so ending a
   * series never rewrites bookings that have already been played and paid for.
   */
  @IsOptional() @IsISO8601() fromDate?: string;
}

export class ListSeriesDto {
  @IsOptional() @IsUUID() venueId?: string;
  @IsOptional() @IsUUID() resourceId?: string;
  @IsOptional() @IsIn(['active', 'ended']) status?: 'active' | 'ended';
}

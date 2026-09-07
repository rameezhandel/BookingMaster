import { Type } from 'class-transformer';
import {
  IsBoolean,
  Max,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const TIME_RE = /^([01]\d|2[0-4]):[0-5]\d(:[0-5]\d)?$/;

export class CreateVenueDto {
  @IsString() @MinLength(2) @MaxLength(160) name: string;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
}

export class UpdateVenueDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;

  @IsOptional()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'The web address may use lowercase letters, numbers and hyphens only.',
  })
  @MaxLength(60)
  slug?: string;

  @IsOptional() @IsBoolean() isPublished?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(365) @Type(() => Number) bookingWindowDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10080) @Type(() => Number) minNoticeMinutes?: number;
  @IsOptional() @IsInt() @Min(2) @Max(60) @Type(() => Number) holdMinutes?: number;
  @IsOptional() @IsBoolean() requiresPrepayment?: boolean;
}

export class CreateResourceDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsString() @MinLength(1) @MaxLength(60) sport: string;
  @IsOptional() @IsIn([30, 60, 90, 120]) @Type(() => Number) slotMinutes?: number;
  /** Starting hours, applied to all seven days. Refine per day via PUT /resources/:id/hours. */
  @IsOptional() @Matches(TIME_RE, { message: 'opensAt must be HH:MM' }) opensAt?: string;
  @IsOptional() @Matches(TIME_RE, { message: 'closesAt must be HH:MM' }) closesAt?: string;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) sortOrder?: number;
}

export class UpdateResourceDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60) sport?: string;
  @IsOptional() @IsIn([30, 60, 90, 120]) @Type(() => Number) slotMinutes?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) sortOrder?: number;
}

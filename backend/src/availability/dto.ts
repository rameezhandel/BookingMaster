import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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

const TIME_RE = /^([01]\d|2[0-4]):[0-5]\d(:[0-5]\d)?$/;

export class HourWindowDto {
  /** 0 = Sunday .. 6 = Saturday. */
  @IsInt() @Min(0) @Max(6) @Type(() => Number) dayOfWeek: number;
  @Matches(TIME_RE, { message: 'opensAt must be HH:MM' }) opensAt: string;
  @Matches(TIME_RE, { message: 'closesAt must be HH:MM' }) closesAt: string;
}

/** The whole week is replaced in one call, so the editor never leaves a half-saved schedule. */
export class SetHoursDto {
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => HourWindowDto)
  windows: HourWindowDto[];
}

export class CreateOverrideDto {
  @IsISO8601() onDate: string;
  /** Omit for the whole venue. */
  @IsOptional() @IsUUID() resourceId?: string;
  @IsOptional() @IsBoolean() isClosed?: boolean;
  @IsOptional() @Matches(TIME_RE) opensAt?: string;
  @IsOptional() @Matches(TIME_RE) closesAt?: string;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

export class ListOverridesDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

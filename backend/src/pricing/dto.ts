import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const TIME_RE = /^([01]\d|2[0-4]):[0-5]\d(:[0-5]\d)?$/;

export class CreatePriceRuleDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;

  /** Days the rule applies to, 0 = Sunday. Omitted means every day. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  @Type(() => Number)
  days?: number[];

  @IsOptional() @Matches(TIME_RE) startsAt?: string;
  @IsOptional() @Matches(TIME_RE) endsAt?: string;

  @IsInt() @Min(0) @Type(() => Number) pricePerHourPaise: number;

  /** Higher wins when two rules cover the same slot. */
  @IsOptional() @IsInt() @Type(() => Number) priority?: number;

  @IsOptional() @IsISO8601() validFrom?: string;
  @IsOptional() @IsISO8601() validTo?: string;
}

export class UpdatePriceRuleDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  @Type(() => Number)
  days?: number[];
  @IsOptional() @Matches(TIME_RE) startsAt?: string;
  @IsOptional() @Matches(TIME_RE) endsAt?: string;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) pricePerHourPaise?: number;
  @IsOptional() @IsInt() @Type(() => Number) priority?: number;
  @IsOptional() @IsISO8601() validFrom?: string;
  @IsOptional() @IsISO8601() validTo?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

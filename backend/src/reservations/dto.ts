import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CustomerRefDto } from '../customers/dto';

export class CreateReservationDto {
  @IsUUID() resourceId: string;
  @IsISO8601() start: string;
  @IsISO8601() end: string;

  /** Either an existing customer... */
  @IsOptional() @IsUUID() customerId?: string;
  /** ...or a name and phone to find-or-create. Both may be omitted for a walk-in. */
  @IsOptional() @ValidateNested() @Type(() => CustomerRefDto) customer?: CustomerRefDto;

  /** Omit to price the slot from the resource's price rules. */
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) amountPaise?: number;

  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class CreateBlockDto {
  @IsUUID() resourceId: string;
  @IsISO8601() start: string;
  @IsISO8601() end: string;
  @IsString() @MinLength(1) @MaxLength(200) reason: string;
}

export class UpdateReservationDto {
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) amountPaise?: number;
  @IsOptional() @IsIn(['confirmed', 'completed', 'no_show']) status?: 'confirmed' | 'completed' | 'no_show';
}

export class ListReservationsDto {
  @IsOptional() @IsUUID() venueId?: string;
  @IsOptional() @IsUUID() resourceId?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsIn(['held', 'confirmed', 'completed', 'cancelled', 'no_show', 'blocked']) status?: string;
  @IsOptional() @IsString() @MaxLength(120) q?: string;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) limit?: number;
}

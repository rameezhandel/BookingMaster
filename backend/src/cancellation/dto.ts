import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CancellationTierDto {
  /** Cancel at least this many hours before the start. */
  @IsInt() @Min(0) @Max(8760) @Type(() => Number) minHoursBefore: number;
  @IsInt() @Min(0) @Max(100) @Type(() => Number) refundPct: number;
}

/** The whole policy is replaced at once, so a half-saved ladder is impossible. */
export class SetPolicyDto {
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CancellationTierDto)
  tiers: CancellationTierDto[];
}

export class CancelReservationDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;

  /** Override what the policy worked out. Still capped at what was collected. */
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) refundPaise?: number;

  /** Write the refund into the payment ledger now. */
  @IsOptional() @IsBoolean() recordRefund?: boolean;
  /**
   * Suppresses the cancellation message so the caller can send its own.
   *
   * The customer-facing flow refunds *after* cancelling — deliberately, so the
   * slot goes back on sale without waiting on a gateway call — and only then
   * knows whether to say "refunded to your card" or "the venue will be in
   * touch". Sending from inside cancel() would guess, and guess wrong.
   */
  @IsOptional() @IsBoolean() suppressNotification?: boolean;

  @IsOptional() @IsIn(['cash', 'upi', 'card', 'bank_transfer', 'other']) refundMethod?:
    | 'cash'
    | 'upi'
    | 'card'
    | 'bank_transfer'
    | 'other';
}

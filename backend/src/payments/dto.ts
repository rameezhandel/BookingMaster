import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreatePaymentDto {
  @IsInt() @Min(1) @Type(() => Number) amountPaise: number;

  /** Cash is first because in practice it is the most common. */
  @IsIn(['cash', 'upi', 'card', 'bank_transfer', 'other']) method:
    | 'cash'
    | 'upi'
    | 'card'
    | 'bank_transfer'
    | 'other';

  @IsOptional() @IsIn(['in', 'refund']) direction?: 'in' | 'refund';
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsISO8601() receivedAt?: string;
}

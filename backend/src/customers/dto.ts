import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Deliberately permissive: owners key in landlines, +91 forms and 10-digit numbers. */
const PHONE_RE = /^[+0-9][0-9 \-()]{6,19}$/;

export class CreateCustomerDto {
  @IsString() @MinLength(1) @MaxLength(160) name: string;
  @Matches(PHONE_RE, { message: 'Enter a valid phone number.' }) phone: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class UpdateCustomerDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) name?: string;
  @IsOptional() @Matches(PHONE_RE, { message: 'Enter a valid phone number.' }) phone?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  /** Set when someone asks the desk to stop messaging them. */
  @IsOptional() @IsBoolean() notificationsOptedOut?: boolean;
}

export class CustomerRefDto {
  @IsString() @MinLength(1) @MaxLength(160) name: string;
  @Matches(PHONE_RE, { message: 'Enter a valid phone number.' }) phone: string;
}

export function normalisePhone(phone: string): string {
  return phone.replace(/[\s\-()]/g, '');
}

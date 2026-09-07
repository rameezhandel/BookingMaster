import { IsISO8601, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, MinLength } from 'class-validator';

export class RequestOtpDto {
  @Matches(/^[+0-9][0-9 \-()]{6,19}$/, { message: 'Enter a valid phone number.' })
  phone: string;
}

export class VerifyOtpDto {
  @IsUUID() challengeId: string;
  @Length(6, 6, { message: 'The code is six digits.' })
  @Matches(/^[0-9]{6}$/, { message: 'The code is six digits.' })
  code: string;
  /** Supplied on a first booking so the venue has a name against it. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) name?: string;
}

export class CreateHoldDto {
  @IsUUID() resourceId: string;
  @IsISO8601() start: string;
  @IsISO8601() end: string;
}

export class CancelOwnBookingDto {
  /** Optional, and only ever a note: the refund comes from the venue's policy. */
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

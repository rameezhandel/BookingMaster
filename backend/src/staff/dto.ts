import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class InviteStaffDto {
  @IsEmail({}, { message: 'Enter a valid email address.' }) @MaxLength(254) email: string;
  @IsString() @MinLength(2) @MaxLength(160) name: string;
  @IsOptional() @IsIn(['owner', 'staff']) role?: 'owner' | 'staff';
}

export class AcceptInviteDto {
  @IsString() @MinLength(16) @MaxLength(200) token: string;
  @IsString() @MinLength(10, { message: 'Use at least 10 characters.' }) @MaxLength(200) password: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(160) name?: string;
}

export class UpdateStaffDto {
  @IsOptional() @IsIn(['owner', 'staff']) role?: 'owner' | 'staff';
  @IsOptional() isActive?: boolean;
}

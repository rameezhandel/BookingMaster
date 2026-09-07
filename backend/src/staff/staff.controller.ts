import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OwnerOnly } from '../auth/roles.guard';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { AcceptInviteDto, InviteStaffDto, UpdateStaffDto } from './dto';
import { StaffService } from './staff.service';

/** Who has a login here. Owners only — this is the keys to the account. */
@Controller('staff')
@UseGuards(JwtAuthGuard)
@OwnerOnly()
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.staff.list(user.tenantId);
  }

  @Get('invites')
  invites(@CurrentUser() user: AuthUser) {
    return this.staff.pendingInvites(user.tenantId);
  }

  @Post('invites')
  invite(@CurrentUser() user: AuthUser, @Body() dto: InviteStaffDto) {
    return this.staff.invite(user.tenantId, user.id, dto);
  }

  @Delete('invites/:id')
  revokeInvite(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.revokeInvite(user.tenantId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStaffDto,
  ) {
    return this.staff.update(user.tenantId, user.id, id, dto);
  }
}

/**
 * Redeeming an invitation. Unauthenticated by necessity — the person has no
 * login yet, which is the whole point — so the token is the only credential and
 * the budget here is tight.
 */
@Controller('invites')
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class InvitesController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  describe(@Query('token') token: string) {
    return this.staff.describeInvite(token ?? '');
  }

  @Post('accept')
  @HttpCode(200)
  accept(@Body() dto: AcceptInviteDto) {
    return this.staff.accept(dto);
  }
}

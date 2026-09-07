import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OwnerOnly } from '../auth/roles.guard';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { CancellationService } from './cancellation.service';
import { SetPolicyDto } from './dto';

@Controller('venues/:id/cancellation-policy')
@UseGuards(JwtAuthGuard)
export class CancellationController {
  constructor(private readonly cancellation: CancellationService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.cancellation.list(user.tenantId, id);
  }

  @OwnerOnly()
  @Put()
  replace(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetPolicyDto,
  ) {
    return this.cancellation.replace(user.tenantId, id, dto.tiers);
  }
}

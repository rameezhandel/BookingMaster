import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { InvitesController, StaffController } from './staff.controller';
import { StaffService } from './staff.service';

@Module({
  imports: [AuditModule],
  controllers: [StaffController, InvitesController],
  providers: [StaffService],
  exports: [StaffService],
})
export class StaffModule {}

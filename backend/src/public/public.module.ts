import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AvailabilityModule } from '../availability/availability.module';
import { PaymentsModule } from '../payments/payments.module';
import { PricingModule } from '../pricing/pricing.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { CustomerJwtStrategy } from './customer-auth';
import { HoldsScheduler } from './holds.scheduler';
import { HoldsService } from './holds.service';
import { OtpService } from './otp/otp.service';
import { ConsoleOtpSender, OTP_SENDER } from './otp/sender';
import { PublicBookingService } from './public-booking.service';
import { PublicBookingController, PublicController } from './public.controller';
import { PublicService } from './public.service';

@Module({
  imports: [
    AvailabilityModule,
    PricingModule,
    ReservationsModule,
    PaymentsModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [PublicController, PublicBookingController],
  providers: [
    PublicService,
    PublicBookingService,
    HoldsService,
    HoldsScheduler,
    OtpService,
    CustomerJwtStrategy,
    // Swap this provider for a real SMS or WhatsApp sender.
    { provide: OTP_SENDER, useClass: ConsoleOtpSender },
  ],
  exports: [PublicService, HoldsService],
})
export class PublicModule {}

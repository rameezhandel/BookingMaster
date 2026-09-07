import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ReservationsModule } from '../reservations/reservations.module';
import { CheckoutController, WebhookController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { PAYMENT_GATEWAY, type PaymentGateway } from './gateway/gateway';
import { RazorpayGateway } from './gateway/razorpay.gateway';
import { StubGateway } from './gateway/stub.gateway';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [
    ReservationsModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [PaymentsController, CheckoutController, WebhookController],
  providers: [
    PaymentsService,
    CheckoutService,
    RazorpayGateway,
    StubGateway,
    {
      // Real credentials win. Without them, and outside production, the stub
      // keeps the whole flow exercisable; in production the stub refuses to
      // work at all, so a missing configuration fails loudly rather than
      // silently accepting money that never moves.
      provide: PAYMENT_GATEWAY,
      inject: [RazorpayGateway, StubGateway],
      useFactory: (razorpay: RazorpayGateway, stub: StubGateway): PaymentGateway =>
        razorpay.configured ? razorpay : stub,
    },
  ],
  exports: [PaymentsService, CheckoutService],
})
export class PaymentsModule {}

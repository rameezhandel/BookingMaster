import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentCustomer, CustomerAuthGuard, type CustomerUser } from '../public/customer-auth';
import { CheckoutService } from './checkout.service';

@Controller('public/holds')
@UseGuards(CustomerAuthGuard)
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post(':id/payment')
  start(@CurrentCustomer() user: CustomerUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.checkout.startPayment(user.tenantId, id, user.id);
  }

  /**
   * The browser polls this rather than trusting its own success callback: the
   * webhook is what decides, and it may land before or after the redirect.
   */
  @Get(':id/payment')
  status(@CurrentCustomer() user: CustomerUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.checkout.statusFor(user.tenantId, id, user.id);
  }
}

@Controller('webhooks')
export class WebhookController {
  constructor(private readonly checkout: CheckoutService) {}

  /**
   * Unauthenticated by design — the signature is the authentication.
   *
   * The throttle is deliberately generous: a gateway retrying a burst of
   * events must not be rate-limited into giving up, and every request here is
   * signature-checked before it costs anything.
   */
  @Post('payments')
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async payments(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') razorpaySignature?: string,
    @Headers('x-webhook-signature') genericSignature?: string,
    @Headers('x-razorpay-event-id') eventId?: string,
  ) {
    // The raw bytes, not the parsed body: re-serialising JSON reorders keys and
    // the signature stops matching.
    const raw = req.rawBody ?? Buffer.alloc(0);
    const outcome = await this.checkout.handleWebhook(
      raw,
      razorpaySignature ?? genericSignature ?? '',
      eventId,
    );
    // Always 200 once accepted, so the gateway stops retrying an event we have
    // recorded. Failures to apply are rethrown before reaching here.
    return { outcome };
  }
}

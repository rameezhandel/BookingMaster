import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskPhone } from '../../public/otp/sender';
import type { NotificationChannel, OutboundMessage, SendOutcome } from './channel';

/**
 * The fallback channel: writes the message to the log.
 *
 * Used when no provider is configured. It reports success so the outbox drains
 * rather than piling up retries for a provider that does not exist — but it
 * says loudly, once per message, that nothing was actually delivered. A
 * notification system that quietly pretends to work is worse than one that is
 * obviously off.
 */
@Injectable()
export class ConsoleChannel implements NotificationChannel {
  readonly name = 'console';
  private readonly logger = new Logger('Notifications');
  private readonly isProduction: boolean;

  constructor(config: ConfigService) {
    this.isProduction = config.get<string>('NODE_ENV') === 'production';
  }

  get configured() {
    return true;
  }

  async send(message: OutboundMessage): Promise<SendOutcome> {
    const to = maskPhone(message.toPhone);
    if (this.isProduction) {
      this.logger.error(
        `No messaging provider configured: "${message.templateName}" for ${to} was not delivered.`,
      );
    } else {
      this.logger.log(`[${message.templateName} -> ${to}]\n${message.preview}`);
    }
    return { ok: true, providerMessageId: null };
  }
}

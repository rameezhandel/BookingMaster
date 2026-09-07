import { Injectable, Logger } from '@nestjs/common';

export interface OtpSender {
  send(phone: string, code: string): Promise<void>;
}

export const OTP_SENDER = Symbol('OTP_SENDER');

/**
 * The default sender: writes the code to the log.
 *
 * There is no SMS or WhatsApp provider wired up. This is deliberately obvious
 * rather than a silent no-op, so nobody deploys thinking messages are going
 * out. A real sender implements this interface — for India that most likely
 * means a WhatsApp template through a BSP, since template approval takes days
 * and delivery beats SMS.
 */
@Injectable()
export class ConsoleOtpSender implements OtpSender {
  private readonly logger = new Logger('OtpSender');

  async send(phone: string, code: string): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      this.logger.error(
        `No OTP provider configured. The code for ${maskPhone(phone)} was not sent to anyone.`,
      );
      return;
    }
    this.logger.log(`OTP for ${maskPhone(phone)} is ${code} (no provider configured)`);
  }
}

/** Logs are read by more people than the database is. */
export function maskPhone(phone: string): string {
  return phone.length <= 4 ? '****' : `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskPhone } from '../../public/otp/sender';
import type { NotificationChannel, OutboundMessage, SendOutcome } from './channel';

/**
 * WhatsApp through Meta's Cloud API.
 *
 * NOT VERIFIED AGAINST THE LIVE API. This environment has no outbound access to
 * Meta and no credentials, so the request below is written from the documented
 * API and has never received a real response. The outbox around it — enqueueing,
 * retries, backoff, dedupe, opt-out — is exercised by the console channel and
 * by tests.
 *
 * Before this sends anything, each template in templates.ts must be registered
 * in the WhatsApp Manager and approved. Until then the API returns an error for
 * every message, which arrives here as a non-retryable failure rather than an
 * infinite retry loop.
 */
@Injectable()
export class WhatsAppChannel implements NotificationChannel {
  readonly name = 'whatsapp';
  private readonly logger = new Logger(WhatsAppChannel.name);
  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly apiVersion: string;

  constructor(config: ConfigService) {
    this.phoneNumberId = config.get<string>('WHATSAPP_PHONE_NUMBER_ID') ?? '';
    this.accessToken = config.get<string>('WHATSAPP_ACCESS_TOKEN') ?? '';
    this.apiVersion = config.get<string>('WHATSAPP_API_VERSION') ?? 'v21.0';
  }

  get configured() {
    return Boolean(this.phoneNumberId && this.accessToken);
  }

  async send(message: OutboundMessage): Promise<SendOutcome> {
    if (!this.configured) {
      return { ok: false, retryable: false, error: 'WhatsApp is not configured.' };
    }

    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      to: message.toPhone.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: message.templateName,
        language: { code: message.language },
        components: [
          {
            type: 'body',
            parameters: message.params.map((text) => ({ type: 'text', text })),
          },
        ],
      },
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // Unreachable is worth retrying; the message is still in the outbox.
      return {
        ok: false,
        retryable: true,
        error: `Unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const text = await res.text();

    if (!res.ok) {
      // 4xx means the request itself is wrong — an unapproved template, a
      // number that cannot receive WhatsApp — and retrying it forever only
      // burns quota. 429 and 5xx are worth another go.
      const retryable = res.status === 429 || res.status >= 500;
      // Never log the response body: it echoes the phone number and parameters.
      this.logger.warn(
        `WhatsApp ${message.templateName} to ${maskPhone(message.toPhone)} failed: HTTP ${res.status}`,
      );
      return { ok: false, retryable, error: `Provider returned HTTP ${res.status}` };
    }

    let providerMessageId: string | null = null;
    try {
      const parsed = JSON.parse(text) as { messages?: { id?: string }[] };
      providerMessageId = parsed.messages?.[0]?.id ?? null;
    } catch {
      /* accepted but unparseable; the send still succeeded */
    }

    return { ok: true, providerMessageId };
  }
}

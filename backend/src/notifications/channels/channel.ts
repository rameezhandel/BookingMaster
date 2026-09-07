import type { TemplateKey } from '../templates';

export interface OutboundMessage {
  toPhone: string;
  templateKey: TemplateKey;
  templateName: string;
  language: string;
  params: string[];
  /** The rendered text, for logs and for channels that send free text. */
  preview: string;
}

export type SendOutcome =
  | { ok: true; providerMessageId: string | null }
  /** Retrying will not help: a bad number, an unapproved template. */
  | { ok: false; retryable: false; error: string }
  /** A timeout, a rate limit, a provider blip. */
  | { ok: false; retryable: true; error: string };

export interface NotificationChannel {
  readonly name: string;
  readonly configured: boolean;
  send(message: OutboundMessage): Promise<SendOutcome>;
}

export const NOTIFICATION_CHANNEL = Symbol('NOTIFICATION_CHANNEL');

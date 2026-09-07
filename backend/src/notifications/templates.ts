/**
 * The message templates.
 *
 * WhatsApp does not let a business start a conversation with free text: every
 * one of these has to be registered with Meta and approved before it will send,
 * and approval takes hours to days. The body text here is the text to register,
 * and the parameter order here is the order Meta will expect — keeping both in
 * one place is the only way they do not drift, because a mismatch is not a
 * compile error, it is a customer receiving "your booking at 7pm is confirmed
 * for Court 3".
 *
 * `npm run templates` prints these for copying into the provider's console.
 */

export interface TemplateContext {
  customerName: string;
  venueName: string;
  courtName: string;
  /** Already formatted in the venue's timezone. */
  when: string;
  amount: string;
  extra?: string;
}

export interface MessageTemplate {
  /** Must match the name registered with the provider, exactly. */
  name: string;
  language: string;
  /** The body as registered, with {{n}} placeholders. */
  body: string;
  /** Values for {{1}}, {{2}}, ... in order. */
  params: (ctx: TemplateContext) => string[];
}

export const TEMPLATES = {
  booking_confirmed: {
    name: 'booking_confirmed',
    language: 'en',
    body: 'Hi {{1}}, your booking at {{2}} is confirmed.\n\n{{3}}\n{{4}}\nAmount: {{5}}\n\nSee you there.',
    params: (c) => [c.customerName, c.venueName, c.when, c.courtName, c.amount],
  },

  booking_cancelled: {
    name: 'booking_cancelled',
    language: 'en',
    body: 'Hi {{1}}, your booking at {{2}} on {{3}} ({{4}}) has been cancelled.\n\n{{5}}',
    // {{5}} carries the refund outcome, which differs enough between "refunded
    // to your card", "collect from the venue" and "no refund applies" that
    // trying to express it with more placeholders makes the template unreadable.
    params: (c) => [c.customerName, c.venueName, c.when, c.courtName, c.extra ?? 'No refund applies.'],
  },

  booking_reminder: {
    name: 'booking_reminder',
    language: 'en',
    body: 'Hi {{1}}, a reminder: you are booked at {{2}}.\n\n{{3}}\n{{4}}\n\nSee you shortly.',
    params: (c) => [c.customerName, c.venueName, c.when, c.courtName],
  },
} as const satisfies Record<string, MessageTemplate>;

export type TemplateKey = keyof typeof TEMPLATES;

/**
 * Fills a template for previewing and logging.
 *
 * This is never what gets sent over WhatsApp — the provider renders the
 * approved template from the parameters. It is what the owner sees in the
 * message log, and what a plain-SMS fallback would send.
 */
export function render(key: TemplateKey, ctx: TemplateContext): { params: string[]; preview: string } {
  const template = TEMPLATES[key];
  const params = template.params(ctx);
  const preview = template.body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? '');
  return { params, preview };
}

/** Every placeholder in a body must have a parameter, and vice versa. */
export function placeholderCount(body: string): number {
  const seen = new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
  return seen.size;
}

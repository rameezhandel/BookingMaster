import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TEMPLATES, placeholderCount, render, type TemplateContext, type TemplateKey } from '../src/notifications/templates';

const ctx: TemplateContext = {
  customerName: 'Arjun',
  venueName: 'Smash Arena',
  courtName: 'Court 1',
  when: 'Sat 14 Nov, 19:00–20:00',
  amount: '₹900',
  extra: '₹900 refunded to your original payment method.',
};

describe('message templates', () => {
  const keys = Object.keys(TEMPLATES) as TemplateKey[];

  /**
   * The failure this guards against is not a crash. A template whose parameter
   * count drifts from the one approved at Meta still sends — with the values in
   * the wrong slots, so a customer is told their booking is confirmed for
   * "Court 3" at "₹900".
   */
  it('gives every placeholder exactly one parameter', () => {
    for (const key of keys) {
      const template = TEMPLATES[key];
      const params = template.params(ctx);
      assert.equal(
        params.length,
        placeholderCount(template.body),
        `${key}: ${params.length} parameters for ${placeholderCount(template.body)} placeholders`,
      );
    }
  });

  it('numbers placeholders from 1 with no gaps', () => {
    for (const key of keys) {
      const numbers = [...TEMPLATES[key].body.matchAll(/\{\{(\d+)\}\}/g)]
        .map((m) => Number(m[1]))
        .sort((a, b) => a - b);
      const unique = [...new Set(numbers)];
      assert.deepEqual(
        unique,
        unique.map((_, i) => i + 1),
        `${key} has a gap or does not start at 1: ${unique.join(',')}`,
      );
    }
  });

  it('never leaves a parameter blank, which would read as a broken message', () => {
    for (const key of keys) {
      for (const [i, value] of TEMPLATES[key].params(ctx).entries()) {
        assert.ok(value && value.trim().length > 0, `${key} parameter ${i + 1} was empty`);
      }
    }
  });

  it('renders a preview with the values substituted in order', () => {
    const { preview, params } = render('booking_confirmed', ctx);
    assert.equal(params[0], 'Arjun');
    assert.ok(preview.startsWith('Hi Arjun, your booking at Smash Arena'));
    assert.ok(preview.includes('Sat 14 Nov, 19:00–20:00'));
    assert.ok(preview.includes('Court 1'));
    assert.ok(preview.includes('₹900'));
    assert.ok(!preview.includes('{{'), 'no placeholder should survive rendering');
  });

  it('falls back to a sensible line when a cancellation has no refund detail', () => {
    const { preview } = render('booking_cancelled', { ...ctx, extra: undefined });
    assert.ok(preview.includes('No refund applies.'));
  });

  it('keeps template names stable, because they are registered externally', () => {
    // Changing one of these silently stops messages sending until the new name
    // is approved, so it should require deliberately editing this test.
    assert.deepEqual(
      keys.map((k) => TEMPLATES[k].name).sort(),
      ['booking_cancelled', 'booking_confirmed', 'booking_reminder'],
    );
  });
});

/**
 * Prints the message templates for registering with the provider.
 *
 * WhatsApp templates are approved by Meta before they will send, and the
 * approval is against exact text. Copying from here rather than retyping is
 * what keeps the parameter order in the console identical to the order this
 * code sends.
 */
import { TEMPLATES, type TemplateKey } from './templates';

const keys = Object.keys(TEMPLATES) as TemplateKey[];

console.log('\nRegister these in the WhatsApp Manager, category "Utility".\n');

for (const key of keys) {
  const t = TEMPLATES[key];
  const placeholders = [...new Set([...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]))];
  console.log('─'.repeat(72));
  console.log(`Name:      ${t.name}`);
  console.log(`Language:  ${t.language}`);
  console.log(`Variables: ${placeholders.length}`);
  console.log('Body:');
  console.log(
    t.body
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
  );
  console.log();
}

console.log('─'.repeat(72));
console.log('Sample values, in order, for the approval form:\n');
for (const key of keys) {
  const params = TEMPLATES[key].params({
    customerName: 'Arjun',
    venueName: 'Smash Arena',
    courtName: 'Court 1',
    when: 'Sat 14 Nov, 19:00-20:00',
    amount: 'Rs 900',
    extra: 'Rs 900 has been refunded.',
  });
  console.log(`${TEMPLATES[key].name}: ${params.map((p, i) => `{{${i + 1}}}=${p}`).join('  ')}`);
}
console.log();

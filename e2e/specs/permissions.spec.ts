import { expect, test } from '@playwright/test';
import { signIn } from '../helpers';

/**
 * The owner/staff split, from the outside.
 *
 * A unit test pins which routes are owner-only. It cannot see the mistake that
 * actually reached a user: a settings screen offering staff five cards whose
 * every control returned 403 on save. What matters here is what is on screen,
 * and that nothing on it fails when pressed.
 */
test('an invited staff member can run the day but not the business', async ({ browser }) => {
  const ownerPage = await browser.newPage();
  await signIn(ownerPage);

  // Invite someone.
  await ownerPage.click('.nav a:has-text("Settings")');
  await ownerPage.waitForSelector('h2:has-text("Who can sign in")');
  const email = `desk.${Date.now()}@example.test`;
  await ownerPage.click('button:has-text("Invite someone")');
  await ownerPage.fill('#inv-name', 'Desk Person');
  await ownerPage.fill('#inv-email', email);
  await ownerPage.click('button:has-text("Create invitation")');
  await ownerPage.waitForSelector('.invite-link');
  const inviteUrl = (await ownerPage.locator('.invite-link').innerText()).trim();

  // They set their own password — the owner never sees it.
  const staffPage = await browser.newPage();
  const denied: string[] = [];
  staffPage.on('response', (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith('/api/') && (r.status() === 401 || r.status() === 403)) {
      denied.push(`${r.status()} ${r.request().method()} ${path}`);
    }
  });
  await staffPage.goto(inviteUrl);
  await staffPage.fill('#ai-password', 'desk-person-password');
  await staffPage.click('button:has-text("Join and sign in")');
  await staffPage.waitForSelector('table.grid', { timeout: 30_000 });

  // The day's work is available.
  const tabs = await staffPage.locator('.nav a').allInnerTexts();
  expect(tabs).toEqual(expect.arrayContaining(['Calendar', 'Bookings', 'Customers']));
  // The business is not.
  expect(tabs).not.toContain('Reports');
  expect(tabs).not.toContain('Activity');

  // Nor by typing the address.
  await staffPage.goto('/reports');
  await expect(staffPage).toHaveURL(/\/calendar$/, { timeout: 15_000 });

  // Settings shows only what they can actually change.
  await staffPage.click('.nav a:has-text("Settings")');
  await staffPage.waitForSelector('.card');
  const cards = await staffPage.locator('.card h2').allInnerTexts();
  expect(cards.join(' ')).toContain('Closures');
  expect(cards.join(' ')).not.toContain('Public booking page');
  expect(cards.join(' ')).not.toContain('Who can sign in');

  // And a closure — the day, not the policy — goes through.
  const when = new Date(Date.now() + 120 * 864e5).toISOString().slice(0, 10);
  await staffPage.fill('#ov-date', when);
  await staffPage.fill('#ov-reason', 'Flooded — heavy rain');
  const closures = staffPage.locator('.card', { has: staffPage.locator('h2:has-text("Closure")') });
  const before = await closures.locator('table.list tr').count();
  await closures.locator('button.primary').first().click();
  await expect(closures.locator('table.list tr')).toHaveCount(before + 1, { timeout: 15_000 });

  // Nothing a staff member was offered may have failed for them.
  expect(denied, 'staff were shown a control that they are not allowed to use').toEqual([]);

  // Switching the login off ends the session already in flight, not at expiry.
  await ownerPage.reload();
  await ownerPage.waitForSelector('h2:has-text("Who can sign in")');
  const row = ownerPage.locator('table.list tr', { hasText: email }).first();
  await row.locator('button:has-text("Switch off")').click();
  await expect(row.locator('button:has-text("Restore")')).toBeVisible({ timeout: 15_000 });

  // Their next request is rejected and the app returns them to sign-in. Any
  // navigation will do; the point is that it happens now rather than whenever
  // the token would have expired.
  await staffPage.goto('/customers');
  await expect(staffPage).toHaveURL(/\/login$/, { timeout: 25_000 });

  await Promise.all([ownerPage.close(), staffPage.close()]);
});

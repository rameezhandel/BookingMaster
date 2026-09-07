import { devices, expect, test } from '@playwright/test';
import { signIn } from '../helpers';

/**
 * The console on a phone, which is where a venue owner actually stands.
 *
 * The failure this guards against is not subtle and was shipped: the nav ran
 * 570px wide in a 390px viewport, so three of the seven pages could not be
 * reached at all. It is invisible at a desk and obvious in a hand.
 */
/*
 * An iPhone's viewport, touch input and user agent, driven by Chromium.
 *
 * Not Safari: this checks layout and reachability, which is where the bug was.
 * Safari's own behaviours — the zoom-on-focus that the 16px field rule exists
 * for — still need a real device.
 */
test.use({ ...devices['iPhone 13'], browserName: 'chromium' });

const PAGES = ['Calendar', 'Bookings', 'Recurring', 'Customers', 'Reports', 'Activity', 'Settings'];

test('no page slides sideways, and every tab can be reached', async ({ page }) => {
  await signIn(page);

  for (const name of PAGES) {
    const tab = page.locator(`.nav a:has-text("${name}")`);
    await tab.scrollIntoViewIfNeeded();
    await tab.tap();
    await page.waitForTimeout(900);

    const pans = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(pans, `${name} makes the whole page pan sideways`).toBe(false);

    // The strip cannot show seven tabs at once, so the one you are on has to be
    // brought into view or the page reads as though nothing is selected.
    const activeVisible = await page.evaluate(() => {
      const a = document.querySelector('.nav a.active');
      const nav = document.querySelector('.nav');
      if (!a || !nav) return false;
      const ar = a.getBoundingClientRect();
      const nr = nav.getBoundingClientRect();
      return ar.left >= nr.left - 1 && ar.right <= nr.right + 1;
    });
    expect(activeVisible, `the active tab is off-screen on ${name}`).toBe(true);
  }
});

test('a booking can be taken from a phone', async ({ page }) => {
  await signIn(page);
  await page.waitForSelector('.slot.free', { timeout: 30_000 });

  const free = page.locator('.slot.free').last();
  await free.scrollIntoViewIfNeeded();
  await free.tap();
  await page.waitForSelector('.modal', { timeout: 20_000 });

  // A sheet is no use if its confirm button is below the fold.
  const actionsReachable = await page.evaluate(() => {
    const modal = document.querySelector('.modal')!;
    const foot = modal.querySelector('.modal-foot') ?? modal.querySelector('.modal-body')!;
    return foot.getBoundingClientRect().bottom <= window.innerHeight + 1;
  });
  expect(actionsReachable, 'the sheet’s actions are below the fold').toBe(true);

  const name = `Phone Booking ${Date.now() % 100000}`;
  await page.fill('#cust-name', name);
  await page.fill('#cust-phone', `+9198450${String(Date.now()).slice(-5)}`);
  await page.locator('.modal button.primary').first().tap();

  await expect(page.locator('.modal')).toHaveCount(0, { timeout: 25_000 });
  await expect(page.locator(`.slot.booked:has-text("${name.split(' ')[0]}")`)).toHaveCount(1);
});

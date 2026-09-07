import { expect, test } from '@playwright/test';
import { signIn } from '../helpers';

/** Far enough out that nothing seeded is near it. */
const day = (offset: number) =>
  new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

const EVENT_DAY = day(210);
const SECOND_DAY = day(211);
const HOLD_UNTIL = day(5);

async function newEnquiry(page: import('@playwright/test').Page, name: string, date: string) {
  await page.click('button:has-text("New enquiry")');
  await page.waitForSelector('#e-name');
  await page.fill('#e-name', name);
  await page.fill('#e-phone', `+91984${String(Date.now()).slice(-7)}`);
  await page.fill('#e-type', 'Wedding reception');
  await page.fill('#e-date', date);
  await page.click('.modal-foot button:has-text("Save")');
  await expect(page.locator(`table.list tr:has-text("${name}")`)).toBeVisible({ timeout: 15_000 });
}

/**
 * The rule the whole hall vertical rests on: an enquiry does not block a date.
 *
 * Several families really do consider the same Saturday, and a system that
 * blocked the date on the first phone call would either lose the venue bookings
 * or teach them to keep the real diary on paper. Only a hold or a booking
 * blocks — and once one does, the database refuses the second, in the browser
 * as everywhere else.
 */
test('two families can want the same Saturday, but only one can have it', async ({ page }) => {
  await signIn(page);
  await page.click('.nav a:has-text("Halls")');
  await page.waitForSelector('h1:has-text("Halls")', { timeout: 20_000 });

  await newEnquiry(page, 'Sharma Family', EVENT_DAY);
  await newEnquiry(page, 'Reddy Family', EVENT_DAY);

  // Two enquiries for the same date, and the date is still free.
  await page.fill('#hall-check', EVENT_DAY);
  await expect(page.locator('.msg.info').first()).toContainText('is free on', { timeout: 10_000 });

  // The first family confirms.
  await page.click('table.list tr:has-text("Sharma Family")');
  await page.waitForSelector('.modal', { timeout: 10_000 });
  await page.click('button:has-text("Hold or book")');
  await page.waitForSelector('#b-date');
  await expect(page.locator('#b-date')).toHaveValue(EVENT_DAY);
  await page.locator('label:has-text("Tentative") input').uncheck();
  await page.click('button:has-text("Book it")');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 20_000 });

  // Now the date reads as taken, by name.
  await page.fill('#hall-check', EVENT_DAY);
  await expect(page.locator('.msg.error').first()).toContainText('is booked for Sharma Family', {
    timeout: 10_000,
  });

  // And the second family cannot be sold it, however hard the desk tries.
  await page.click('table.list tr:has-text("Reddy Family")');
  await page.waitForSelector('.modal', { timeout: 10_000 });
  await page.click('button:has-text("Hold or book")');
  await page.waitForSelector('#b-date');
  await page.locator('label:has-text("Tentative") input').uncheck();
  await page.click('button:has-text("Book it")');
  await expect(page.locator('.modal .msg.error')).toContainText('already taken', {
    timeout: 20_000,
  });

  // They take the Sunday instead, tentatively — which does block it, and says
  // when it stops blocking it.
  await page.fill('#b-date', SECOND_DAY);
  await page.locator('label:has-text("Tentative") input').check();
  await page.fill('#b-hold', HOLD_UNTIL);
  await page.click('button:has-text("Hold it")');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 20_000 });

  const held = page.locator('table.list tr:has-text("Reddy")').first();
  await expect(held).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.card:has-text("The diary") .pill.held').first()).toHaveText('on hold');
  await expect(page.locator('.card:has-text("The diary")')).toContainText('released');
});

/** A hall is not a court, and must not turn up where courts are sold. */
test('the hall stays off the court calendar and off the public page', async ({ page }) => {
  await signIn(page);
  await page.waitForSelector('table.grid', { timeout: 20_000 });
  await expect(page.locator('table.grid th:has-text("Banquet Hall")')).toHaveCount(0);

  await page.goto('/v/smash-arena-hsr');
  await page.waitForSelector('.court-block, .empty', { timeout: 20_000 });
  await expect(page.locator('body')).not.toContainText('Banquet Hall');
});

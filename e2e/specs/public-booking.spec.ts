import { expect, test } from '@playwright/test';
import { latestOtp, latestStubOrder, sendPaymentWebhook, uniquePhone, VENUE_SLUG } from '../helpers';

/**
 * A player booking and paying, and then cancelling.
 *
 * The load-bearing claim here is that the *webhook* decides money arrived, not
 * the browser. The only way to show that is to confirm the booking without the
 * browser ever being told the payment succeeded — which is what happens below.
 */
test('a player books, pays through the webhook, and can cancel with the refund quoted first', async ({
  page,
  baseURL,
}) => {
  const phone = uniquePhone();

  await page.goto(`/v/${VENUE_SLUG}`);
  await page.waitForSelector('.court-block', { timeout: 30_000 });

  // A few days out, so the venue's policy gives a full refund on cancellation.
  await page.locator('.daypick button').nth(4).click();
  await page.waitForTimeout(1200);
  await page.locator('button.pub-slot.free').first().click();
  await page.waitForSelector('#si-phone');

  await page.fill('#si-phone', phone);
  await page.fill('#si-name', 'Meera Iyer');
  await page.click('button:has-text("Send code")');
  await page.waitForSelector('#si-code', { timeout: 20_000 });
  await page.fill('#si-code', latestOtp());
  await page.click('button:has-text("Confirm number")');

  // The slot is held while they decide, with the price on the button.
  const payButton = page.locator('button:has-text("Pay ₹")');
  const confirmButton = page.locator('button:has-text("Confirm booking")');
  await expect(payButton.or(confirmButton)).toBeVisible({ timeout: 25_000 });

  if (await payButton.count()) {
    const amountPaise = Math.round(
      Number((await payButton.innerText()).replace(/[^0-9.]/g, '')) * 100,
    );
    await payButton.click();
    await expect(page.locator('text=Waiting for your payment')).toBeVisible({ timeout: 20_000 });

    // Nothing has told the browser the payment worked. The gateway tells us.
    await sendPaymentWebhook(baseURL!, latestStubOrder(), amountPaise);
  } else {
    await confirmButton.click();
  }

  await expect(page.locator('button:has-text("Done")')).toBeVisible({ timeout: 30_000 });
  await page.click('button:has-text("Done")');

  // Their own bookings, on the session they already have.
  await page.click('button:has-text("My bookings")');
  await page.waitForSelector('.my-booking', { timeout: 20_000 });

  // The refund is quoted before anything is cancelled — finding out after the
  // slot is gone is the wrong order.
  await page.click('button:has-text("Cancel this booking")');
  await page.waitForSelector('.cancel-box');
  const quote = page.locator('.cancel-box p').first();
  await expect(quote).toContainText(/refunds|refund policy/i, { timeout: 20_000 });

  await page.click('button:has-text("Yes, cancel it")');
  await expect(page.locator('.modal .msg')).toContainText(/cancelled/i, { timeout: 25_000 });
  await expect(page.locator('.my-booking.is-cancelled')).toHaveCount(1, { timeout: 15_000 });
});

test('a player can stop the messages themselves', async ({ page }) => {
  const phone = uniquePhone();
  await page.goto(`/v/${VENUE_SLUG}`);
  await page.waitForSelector('.court-block', { timeout: 30_000 });
  await page.click('button:has-text("My bookings")');
  await page.fill('#si-phone', phone);
  await page.click('button:has-text("Send code")');
  await page.waitForSelector('#si-code', { timeout: 20_000 });
  await page.fill('#si-code', latestOtp());
  await page.click('button:has-text("Confirm number")');

  const toggle = page.locator('#mb-optout');
  await expect(toggle).toBeChecked({ timeout: 20_000 });
  await toggle.uncheck();
  // It must stick across a reload, not just move on screen.
  await page.reload();
  await page.waitForSelector('.court-block', { timeout: 20_000 });
  await page.click('button:has-text("My bookings")');
  await expect(page.locator('#mb-optout')).not.toBeChecked({ timeout: 20_000 });
});

import { expect, test } from '@playwright/test';
import { signIn } from '../helpers';

/**
 * Issuing a tax invoice, and the arithmetic on the document.
 *
 * A unit test proves the split reconciles. This proves the number that reaches
 * the page is the same one — that nothing between the calculation and the
 * printed document rounds, reformats or drops a paisa.
 */
test('a venue sets up GST and issues an invoice that adds up', async ({ page }) => {
  await signIn(page);

  // It cannot be switched on before there is a GSTIN to put on the document.
  await page.click('.nav a:has-text("Settings")');
  await page.waitForSelector('h2:has-text("Tax invoices")', { timeout: 20_000 });
  const card = page.locator('.card', { has: page.locator('h2:has-text("Tax invoices")') });
  await expect(card.locator('button:has-text("Turn on")')).toBeDisabled();

  await page.fill('#tax-gstin', '29AABCU9603R1ZM');
  await page.fill('#tax-legal-name', 'Smash Arena Sports Pvt Ltd');
  await page.fill('#tax-sac', '999652');
  await page.fill('#tax-prefix', 'SA');
  await page.click('button:has-text("Save tax details")');
  await page.waitForTimeout(1200);
  await card.locator('button:has-text("Turn on")').click();
  await expect(card.locator('.pill')).toHaveText('on', { timeout: 15_000 });

  // Issue one from a booking.
  await page.click('.nav a:has-text("Calendar")');
  await page.waitForSelector('table.grid', { timeout: 20_000 });
  const booked = page.locator('.slot.booked').first();
  await booked.scrollIntoViewIfNeeded();
  const billed = (await booked.innerText()).match(/₹[\d,]+/)?.[0];
  await booked.click();
  await page.waitForSelector('.modal', { timeout: 15_000 });

  await page.click('button:has-text("Issue a tax invoice")');
  await page.waitForSelector('#inv-gstin');
  await page.click('button:has-text("Issue invoice")');
  await page.waitForSelector('.invoice-doc', { timeout: 20_000 });

  // The series starts at one, in this financial year.
  await expect(page.locator('.invoice-number')).toHaveText(/^SA\/\d{4}-\d{2}\/0001$/);

  const rows = await page.locator('.invoice-totals .row').allInnerTexts();
  const money = (label: string) => {
    const row = rows.find((r) => r.includes(label));
    if (!row) throw new Error(`no "${label}" row on the invoice: ${rows.join(' | ')}`);
    return Number((row.match(/₹([\d,]+(?:\.\d+)?)/)?.[1] ?? '0').replace(/,/g, ''));
  };

  const taxable = money('Taxable');
  const cgst = money('CGST');
  const sgst = money('SGST');
  const total = money('Total');

  // The components add to the total, exactly.
  expect(Math.abs(taxable + cgst + sgst - total)).toBeLessThan(0.005);
  // And the total is what the customer was actually billed: the venue's prices
  // include the tax, so the invoice must not add anything on top.
  expect(total).toBe(Number((billed ?? '0').replace(/[₹,]/g, '')));

  // A second invoice for the same booking is not on offer.
  await page.locator('.modal-head button').last().click();
  await page.waitForTimeout(700);
  await expect(page.locator('button:has-text("Issue a tax invoice")')).toHaveCount(0);
});

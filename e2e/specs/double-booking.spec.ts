import { expect, test } from '@playwright/test';
import { signIn } from '../helpers';

/**
 * The guarantee the product is sold on, from two browsers.
 *
 * A database test proves the exclusion constraint holds. It cannot prove that
 * the loser of the race is *told* — that the 409 reaches the screen as words a
 * person can act on rather than a blank failure or, worse, a second booking
 * appearing to succeed. That has only ever been checked by hand.
 */
test('two people cannot take the same slot, and the loser is told', async ({ browser, baseURL }) => {
  const [alice, bob] = await Promise.all([browser.newPage(), browser.newPage()]);

  await signIn(alice);
  await signIn(bob);

  // Both are looking at the same calendar, before either has booked.
  for (const page of [alice, bob]) {
    await page.waitForSelector('.slot.free', { timeout: 30_000 });
  }

  // The same slot, identified the same way in both tabs.
  const slotOf = (page: typeof alice) => page.locator('.slot.free').last();
  const label = await slotOf(alice).innerText();
  expect(await slotOf(bob).innerText()).toBe(label);

  const book = async (page: typeof alice, name: string) => {
    await slotOf(page).click();
    await page.waitForSelector('#cust-name', { timeout: 15_000 });
    await page.fill('#cust-name', name);
    await page.fill('#cust-phone', `+9198450${String(Date.now()).slice(-5)}`);
    await page.locator('.modal button.primary').first().click();
  };

  // Alice takes it. Bob's tab still shows it as free — this is the stale-tab
  // case, which is the one that actually happens at a counter.
  await book(alice, 'Alice Racer');
  await expect(alice.locator('.modal')).toHaveCount(0, { timeout: 20_000 });

  await book(bob, 'Bob Racer');

  // Bob must be told, in words, and his booking must not exist.
  const error = bob.locator('.modal .msg.error');
  await expect(error).toBeVisible({ timeout: 20_000 });
  const text = await error.innerText();
  expect(text.toLowerCase()).toMatch(/just been booked|already|taken|no longer/);

  // And the slot belongs to exactly one of them.
  await bob.locator('.modal-head button').click();
  await bob.reload();
  await bob.waitForSelector('table.grid', { timeout: 30_000 });
  await expect(bob.locator('.slot.booked:has-text("Alice")')).toHaveCount(1);
  await expect(bob.locator('.slot.booked:has-text("Bob")')).toHaveCount(0);

  await Promise.all([alice.close(), bob.close()]);
});

/**
 * The same race through the API, at a concurrency no human can produce by
 * clicking. The database test covers the constraint; this covers the whole
 * request path on top of it — transaction handling, the sweep-and-retry, and
 * the error mapping.
 */
test('twenty simultaneous requests for one slot leave exactly one booking', async ({ request, baseURL }) => {
  const login = await request.post(`${baseURL}/api/auth/login`, {
    data: { email: 'owner@smasharena.test', password: 'bookingmaster' },
  });
  const { token } = await login.json();
  const auth = { Authorization: `Bearer ${token}` };

  const venues = await (await request.get(`${baseURL}/api/venues`, { headers: auth })).json();
  const courts = await (
    await request.get(`${baseURL}/api/venues/${venues[0].id}/resources`, { headers: auth })
  ).json();

  // Well into the future, so nothing the other specs do can collide with it.
  const start = new Date(Date.now() + 400 * 864e5);
  start.setUTCHours(4, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60_000);

  const attempts = Array.from({ length: 20 }, (_, i) =>
    request.post(`${baseURL}/api/reservations`, {
      headers: auth,
      data: {
        resourceId: courts[0].id,
        start: start.toISOString(),
        end: end.toISOString(),
        customer: { name: `Racer ${i}`, phone: `+91984500${String(i).padStart(4, '0')}` },
        allowOutsideHours: true,
      },
    }),
  );

  const results = await Promise.all(attempts);
  const created = results.filter((r) => r.status() === 201);
  const conflicted = results.filter((r) => r.status() === 409);

  expect(created).toHaveLength(1);
  // Everyone else gets a clean conflict, not a 500.
  expect(conflicted).toHaveLength(19);
});

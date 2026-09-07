/**
 * The owner/staff split, as a list.
 *
 * Two things go wrong with permissions and neither announces itself. A route
 * added next to owner-only ones inherits the decorator by copy-paste and
 * quietly locks staff out of their own job; or an owner-only route is added
 * without the decorator and staff can change prices. Both are found by a person
 * at a desk, months later.
 *
 * So the matrix is written down here and compared against what the controllers
 * actually declare. Changing the split means changing this list, deliberately.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import 'reflect-metadata';
import { ROLES_KEY } from '../src/auth/roles.guard';

/**
 * Every route only an owner may call, as `METHOD path`.
 *
 * The rule behind the list: owners decide the *business* — money, prices, what
 * the public sees, and who has a login. Staff run the *day*. A permission model
 * that gets in the way at the counter is worked around by sharing the owner's
 * password, which is the thing roles exist to stop.
 */
const OWNER_ONLY = [
  // Money in aggregate, and the record of who did what.
  'GET reports/summary',
  'GET audit',

  // What the venue charges.
  'POST resources/:id/price-rules',
  'PATCH price-rules/:id',
  'DELETE price-rules/:id',
  'PUT venues/:id/cancellation-policy',

  // The venue itself, and what the public sees of it.
  'POST venues',
  'PATCH venues/:id',
  'POST venues/:id/resources',
  'PATCH resources/:id',
  'DELETE resources/:id',
  'PUT resources/:id/hours',

  // Who else can sign in.
  'GET staff',
  'GET staff/invites',
  'POST staff/invites',
  'DELETE staff/invites/:id',
  'PATCH staff/:id',
].sort();

/**
 * Routes that must stay open to staff, named so a copy-pasted decorator is
 * caught rather than merely noticed. A closure is the day, not the policy:
 * whoever is at the desk knows the turf is flooded.
 */
const MUST_STAY_OPEN = [
  'POST venues/:id/overrides',
  'DELETE overrides/:id',
  'GET calendar',
  'POST reservations',
  'POST reservations/block',
  'POST reservations/:id/cancel',
  'POST reservations/:id/payments',
  'GET customers',
  'PATCH customers/:id',
  'POST series',
  'GET venues/:id/messages',
];

/** Reads the routes a controller declares, and which are marked owner-only. */
function routesOf(controllerClass: new (...args: never[]) => unknown) {
  const base = Reflect.getMetadata('path', controllerClass) ?? '';
  const classOwnerOnly = Reflect.getMetadata(ROLES_KEY, controllerClass) as string[] | undefined;
  const proto = controllerClass.prototype as Record<string, unknown>;

  const routes: { route: string; ownerOnly: boolean }[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const handler = proto[name];
    if (typeof handler !== 'function') continue;

    const path = Reflect.getMetadata('path', handler);
    const method = Reflect.getMetadata('method', handler);
    if (path === undefined || method === undefined) continue;

    const roles = (Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined) ?? classOwnerOnly;
    const full = [base, path].filter((p) => p && p !== '/').join('/');
    routes.push({
      route: `${METHODS[method as number]} ${full}`,
      ownerOnly: !!roles?.includes('owner'),
    });
  }
  return routes;
}

// Nest's RequestMethod enum, in its declared order.
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

/** Every controller in the app, loaded from disk so a new one cannot be missed. */
async function allControllers() {
  const src = join(__dirname, '..', 'src');
  const found: (new (...args: never[]) => unknown)[] = [];

  for (const dir of readdirSync(src, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(src, dir.name))) {
      if (!file.endsWith('.controller.ts')) continue;
      const module = await import(join(src, dir.name, file));
      for (const exported of Object.values(module)) {
        if (typeof exported === 'function' && Reflect.hasMetadata('path', exported)) {
          found.push(exported as new (...args: never[]) => unknown);
        }
      }
    }
  }
  return found;
}

describe('the owner/staff split', () => {
  it('marks exactly the routes on the list as owner-only', async () => {
    const declared: string[] = [];
    for (const controller of await allControllers()) {
      for (const { route, ownerOnly } of routesOf(controller)) {
        if (ownerOnly) declared.push(route);
      }
    }
    declared.sort();

    const added = declared.filter((r) => !OWNER_ONLY.includes(r));
    const removed = OWNER_ONLY.filter((r) => !declared.includes(r));

    assert.deepEqual(
      { added, removed },
      { added: [], removed: [] },
      'The owner-only set changed. If that was deliberate, update OWNER_ONLY above; ' +
        '"added" locks staff out of something, "removed" opens something up.',
    );
  });

  it('keeps the day-to-day routes open to staff', async () => {
    const ownerOnly = new Set<string>();
    for (const controller of await allControllers()) {
      for (const { route, ownerOnly: restricted } of routesOf(controller)) {
        if (restricted) ownerOnly.add(route);
      }
    }
    const wronglyClosed = MUST_STAY_OPEN.filter((r) => ownerOnly.has(r));
    assert.deepEqual(wronglyClosed, [], 'These must stay open to staff');
  });

  it('does not leave an owner-only route unreachable from the UI', () => {
    // Every owner-only route should be behind a screen the owner can find. This
    // catches the reverse of the reported bug: a control shown to staff that
    // only ever fails for them.
    const settings = readFileSync(
      join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'SettingsPage.tsx'),
      'utf8',
    );
    // The cards that write to owner-only routes must be rendered behind isOwner.
    for (const card of ['VenueCard', 'PublishCard', 'CourtsCard', 'CancellationPolicyCard', 'TeamCard']) {
      const rendered = new RegExp(`\\{isOwner && <${card}\\b|isOwner \\? <${card}\\b`);
      assert.match(
        settings,
        rendered,
        `${card} writes to owner-only routes, so it must not be offered to staff`,
      );
    }
  });
});

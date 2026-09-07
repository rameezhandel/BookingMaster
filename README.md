# BookingMaster

A booking platform for sports venues. **Phase 0 is the venue owner's own calendar** —
the tool they use at the desk and on the phone, before any customer-facing booking
page exists.

That order is deliberate. Venue software dies when the owner stops keeping the
calendar current: the moment their notebook is more truthful than the screen,
online bookings start colliding with walk-ins and the product is abandoned. So the
first thing built is the thing the owner touches fifty times a day. Online booking
becomes a feature added to a calendar that is already trusted, rather than the
other way round.

## What it does today

**Owner**
- Sign up, create a venue and its courts, set opening hours
- Day calendar across all courts, with a week occupancy strip
- Quick-book a phone or walk-in customer in three taps
- Block time for rain, maintenance or a tournament
- Record payments in cash, UPI, card or bank transfer, including part payments and refunds
- Mark bookings played or no-show
- Customer list with booking history — "is this a regular?"
- Revenue report: billed, collected, outstanding, and a breakdown per court

**Not here yet, on purpose:** public booking page, online payments, holds and
expiry, notifications, recurring bookings, discovery, mobile apps. Those are
phase 1 and beyond. See [Roadmap](#roadmap).

## Running it

Requires Node 20+ and Postgres 16+.

```bash
# 1. database — either use the compose file
docker compose up -d db
#    ...or point at your own Postgres and edit backend/.env

# 2. configure
cp backend/.env.example backend/.env    # then set DATABASE_URL and JWT_SECRET

# 3. install, migrate, seed
npm install
npm run migrate
npm run seed        # optional: a demo venue with 5 courts and some bookings

# 4. run
npm run dev         # API on :3000, web on :5173
```

Open http://localhost:5173. If you seeded, sign in with
`owner@smasharena.test` / `bookingmaster`. Otherwise sign up and the first-run
screen will create your venue and courts.

The migration runs `CREATE EXTENSION btree_gist`, which needs a superuser or a
database where that extension is already available.

```bash
npm test            # 23 tests; the integration ones need DATABASE_URL
```

## Deploying

The API serves the built web bundle, so the whole thing is **one container and
one origin** — no CORS in the request path and no second service to keep in sync.

```bash
docker compose --profile app up --build      # the full stack, locally
```

Blueprints are included for [Render](render.yaml) and [Fly](fly.toml). Both run
migrations as a **release step**, not on instance boot: with more than one
replica, boot-time migration means every replica races the same DDL. The
`MIGRATE_ON_BOOT` env var exists for single-instance and local use only.

Point health checks at `/health/ready`, which verifies the database is actually
reachable. `/health` is liveness only and deliberately does not touch the
database, so a database blip restarts nothing.

Required in production:

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Postgres 16+. The database must allow `CREATE EXTENSION btree_gist`. |
| `JWT_SECRET` | `openssl rand -hex 32`. The app **refuses to start** if this is missing, short, or still the example value. |
| `TRUST_PROXY` | Set `true` only behind a proxy or PaaS router. Off by default: trusting `X-Forwarded-For` without a proxy in front lets any client forge its own IP and walk around the rate limiter. |

**The database role must not be a superuser and must not have `BYPASSRLS`.**
Either one silently disables tenant isolation. The app checks its own role at
startup and refuses to boot in production if it can bypass. Managed Postgres
usually hands you a database owner rather than a superuser, which is what you
want; where a provider gives a superuser by default, create a plain role for the
application and let it own the tables.

Hardening in place: `helmet`, a global per-IP request ceiling with a much
tighter budget on `/api/auth/login` and `/api/auth/register`, boot-time
environment validation, graceful shutdown so the connection pool drains on
`SIGTERM`, and a non-root container user.

Also in place: request ids (echoed as `x-request-id` and quoted in error
responses, so a user reporting a failure can be matched to the exact request),
structured request logging in production, a statement timeout so a runaway query
cannot pin a connection, and keyset pagination on the lists that grow.

**Not yet done, and worth knowing before this holds anyone's real data:**
backups and restore drills, and a second pair of eyes on the auth flow.

## The decisions worth knowing

### Double-booking is prevented by the database, not by application code

This is the centre of the design. `SELECT` to check availability and then
`INSERT` is a race, and it loses at exactly the worst moment — two people tapping
the last 7pm slot on a Saturday. Postgres can express the constraint directly:

```sql
CONSTRAINT reservation_no_overlap EXCLUDE USING gist (
  resource_id WITH =,
  during      WITH &&
) WHERE (status IN ('held', 'confirmed', 'completed', 'blocked'))
```

The database now *physically cannot* hold two overlapping reservations for one
court. Redis locks, advisory locks and optimistic retries are all strictly worse
versions of this. The application's only job is to catch the violation
(SQLSTATE `23P01`) and turn it into a clean `409`.

`test/concurrency.test.ts` races 20 simultaneous connections at one slot and
asserts exactly one wins. The UI is verified the same way: two tabs on a stale
calendar, and the loser is told rather than silently double-booked.

Two things fall out for free:

- **Maintenance blocks are just reservations** with `status = 'blocked'`. One
  table, one code path, and blocking a booked slot is refused automatically.
- **`cancelled` and `no_show` are deliberately excluded** from the constraint. A
  no-show slot should be resellable to a walk-in while the hour is still running.

### Slots are generated, never stored

Availability is opening-hour rules plus exceptions, and slots are computed on
every read. A materialised slots table would be millions of rows, would go stale
the moment a venue changed its hours, and would turn every rule change into a
backfill. Changing a court's hours changes tomorrow's calendar immediately.

Ranges are half-open — `[19:00, 20:00)` — which is what makes 19:00–20:00 and
20:00–21:00 adjacent rather than overlapping.

Opening hours resolve in three layers, most specific first:

1. a **date override for one court** — "the turf opens 18:00–23:00 on Diwali"
2. a **date override for the whole venue** — "we're shut on the 26th"
3. the **weekly rules** — per weekday, and more than one window per day, because
   venues really do close midday for school or academy hours

A day with no window is closed, and generates no slots at all. That is different
from a `block` reservation, which occupies a slot that does exist. Booking into
closed hours is refused unless the caller passes `allowOutsideHours` — the owner
is the authority, but it should be a decision rather than a slip.

Non-overlap of opening windows is enforced by the database too, with the same
kind of exclusion constraint used for bookings (over a custom `timerange` type,
since Postgres ships range types for dates and timestamps but not for `time`).

### Pricing is data, not branches

A `price_rule` row carries a day mask, a time window, an optional date range, a
per-hour rate and a priority. The highest-priority rule covering the slot start
wins; ties break towards the narrower window, which is what an owner means when
they add "Saturday evening" on top of "Saturday". No rule matching returns
`null`, so the UI says *no price set* instead of quietly charging zero.

`resolvePrice` is a pure function with no database, because pricing is the part
owners argue about and it has to be testable.

### Money is integer paise, and payments are their own table

`bigint` paise everywhere; rupees exist only at the input and the display. A
booking has *many* payments — part payment now, balance on the day, a partial
refund later — so an `amount_paise` column on the booking could never be the
whole truth.

Payments record a **method**, cash included. A large share of venue money in
India moves offline; a system that only understands a gateway is one the owner
cannot reconcile against, and therefore will not use.

> One bug found during the build is worth recording. Collected totals were first
> written as a correlated subquery over `payment` referencing `reservations.id`.
> Drizzle renders that column reference *unqualified*, so inside `FROM payment p`
> it bound to payment's own `id` — every total silently read as zero, with no
> error. It is now a joined aggregate (`src/common/paid-totals.ts`), with a
> regression test. Wrong money that does not throw is the worst kind of wrong.

### Recurring bookings are a rule, not copied rows

Academies and regular weekly groups are a large slice of court revenue, and an
owner re-entering the same booking every week will stop doing it.

A `booking_series` holds the rule — court, weekday, time, duration. The bookings
it produces are ordinary reservations, so every guarantee the calendar already
relies on still applies: each occurrence goes through the same exclusion
constraint, and a recurring booking can never quietly overwrite a one-off that
got there first.

Occurrences are inserted **one at a time, not in a single transaction**. A clash
in week three must not roll back the eleven weeks that were bookable. Whatever
could not be created comes back as `skipped` with a reason — clash, closure,
outside opening hours — because an owner who believes they have a Tuesday slot
for six months, and does not, finds out at the worst possible moment.

A unique index on `(series_id, occurrence_date)` for live rows makes
re-materialising safe to retry, and a nightly job rolls active series forward so
a weekly group never runs out of bookings. That job takes a Postgres advisory
lock, so several replicas do not duplicate the work.

Ending a series cancels from today forward by default. Bookings already played,
or already paid for, are history and stay on the books.

### Cancellation refunds are policy, not arithmetic

A venue's refund ladder is configuration: "cancel 24 hours out for a full refund,
12 hours for half, later for nothing". Resolution picks the most generous
threshold the cancellation still clears.

Three things the engine is careful about:

- **A percentage of the bill, capped at what was collected.** A booking billed
  ₹900 with ₹200 paid cannot refund ₹900 however generous the policy is, and the
  cap is reported so the UI can explain the smaller number rather than just show
  it.
- **No policy is not a policy of zero.** A venue with no tiers gets told exactly
  that, and the owner enters a refund by hand, rather than the system quietly
  refunding nothing.
- **The decision is stored on the booking, not recomputed.** Replaying today's
  policy against a cancellation from six months ago would give a different
  answer, and the number that matters is the one the customer was told.

The refund is quoted *before* the owner commits, and stays editable: telling a
customer what they get back after the booking is already cancelled is the wrong
order. A ladder that pays out more for cancelling later is rejected, because that
mistake is invisible until a customer finds it.

### The public page shows availability and nothing else

A venue can publish a page at `/v/<slug>` for its players. Publishing is opt-in,
refused until the venue has at least one court, and an unpublished slug returns
the same 404 as a nonexistent one — so a slug cannot be probed to find out who is
about to launch.

The public responses are built from an explicit column list rather than by
stripping fields off an internal shape. A taken slot is reported as `taken` and
nothing more: who booked it, what they paid, and whether it is a booking or
maintenance are absent because the query never selects them.

Resolving a slug to a tenant is the one query in the system that legitimately
crosses tenants — a visitor arrives with a slug and nothing else. It is
deliberately narrow (one row, three columns, no customer data), and everything
after it runs adopted into that tenant under the ordinary policies.

Two limits keep the public honest: a booking window, so nobody reserves a court
for a Tuesday in 2031, and a minimum notice, because turning up to a court booked
ninety seconds ago is nobody's idea of a good time. Neither applies to the owner
booking from the calendar.

### Holds, and the gap the constraint cannot see

A public booking takes a hold first: an ordinary reservation with status
`held`, so it sits in the same exclusion constraint as a confirmed booking and
two people cannot hold one slot. What it adds is a deadline.

The subtle part is that **the exclusion constraint cannot evaluate `now()`**. To
the database an expired hold still occupies its slot until something updates the
row, so availability can honestly show a slot as free while the insert is
rejected. A timer alone cannot close that gap — it only narrows it. So a
conflict triggers a targeted sweep of exactly that court and interval, and one
retry. If it fails again, the slot really is taken.

Abandoned checkouts are deleted rather than cancelled: a hold that never became
a booking is someone who closed a tab, not history, and keeping them would fill
the owner's bookings list with ghosts. A hold that somehow attracted a payment is
cancelled and flagged instead, so money is never detached from its record.

### Catching an error inside a transaction is not enough

Two bugs here were the same mistake, and it is worth stating plainly because the
symptom is so misleading. In Postgres a **failed statement aborts the entire
transaction**; catching the error in JavaScript does not make it usable again.
Every later statement fails and the commit becomes a rollback — so the request
returns `201` while nothing was written.

It bit twice: an audit insert that violated a foreign key silently rolled back
the booking it was describing, and a conflicting hold insert poisoned the
transaction that was meant to sweep and retry. Both are now wrapped in a
`SAVEPOINT` (a nested transaction), which confines the failure to the statement
that caused it. `test/transactions.test.ts` demonstrates both halves so the shape
of the fix is not refactored away.

A related trap, same root: `db` resolves to the ambient transaction *from
AsyncLocalStorage*, or the pool. Opening a transaction and setting a flag on it
does nothing unless that transaction is the ambient one — the hold sweeper first
failed exactly this way, with no error and no log line, just holds that never
expired. `runAsTenant` and `runAsSystem` exist so that is done in one place.

### Identity is a phone number

No accounts, no passwords. A code is sent to a phone, and a verified number
becomes a short-lived session scoped to one venue.

Codes are stored only as hashes, drawn from the CSPRNG, capped at five attempts
counted on the challenge itself (so asking for a fresh code does not reset the
budget), and rate-limited per number on top of the endpoint's own throttle. The
response never reveals whether a number is already a customer, so the endpoint
cannot be used to enumerate a venue's customer list.

Customer tokens and staff tokens are signed with the same key, so each carries a
`typ` and each strategy rejects the other. Without that, a phone-verified session
would authenticate against the entire owner console.

**There is no SMS or WhatsApp provider wired up.** The default sender writes the
code to the log and says so loudly in production rather than failing silently.
`OtpSender` is the interface to implement.

### The webhook decides that money arrived, not the browser

A customer closes the tab, loses signal, or never comes back from the payment
page. The gateway's webhook still arrives, so that is what confirms a booking.
The browser polls our own status endpoint rather than trusting its own success
callback, which can land before the webhook, after it, or not at all.

- **Signatures are checked against the raw bytes**, before the body is parsed or
  stored. Re-serialising parsed JSON reorders keys and changes whitespace, and
  the signature stops matching — this is the single most common way webhook
  verification gets quietly disabled. There is a test that fails if anyone
  "helpfully" switches to the parsed body.
- **Idempotency is a unique index** on `(gateway, event_id)`, and the event row
  is inserted *before* it is acted on. Gateways retry on timeouts and on any
  non-2xx; without this a retry confirms a booking twice and records the money
  twice. Insert-and-catch beats check-then-act, which is a race.
- **A late payment is refunded automatically.** If the hold expired and was
  swept, or the slot went to someone else, the money goes back. Leaving it is the
  one outcome nobody forgives. A refund that itself fails is logged at error
  level with everything needed to do it by hand.
- **A short payment is refunded, not accepted.** The amount is compared against
  what we asked the gateway for, never against anything the browser said. An
  overpayment still confirms — refusing would be worse for the customer — but it
  is logged and recorded in the audit trail, because the difference is owed back
  and only a person can decide how.

**The Razorpay adapter has never spoken to the live API.** The environment this
was built in has no outbound access to Razorpay and no credentials, so the order
and refund calls are written from the documented API and are unverified. Run a
pass against test keys before taking real money.

Everything around them *is* exercised, because the stub gateway signs webhooks
with the same HMAC-SHA256-over-raw-body scheme. It is not a mock: signature
verification, replay rejection, idempotency, confirmation, and the late-refund
path all run against real code. In production the stub refuses to work at all —
a stub that silently accepts money is worse than no payments.

### Tenant isolation is enforced by the database

Every tenant-owned row carries `tenant_id` and every service takes it as an
explicit argument. Row-level security is the backstop for the one query that
eventually forgets, because in a multi-tenant booking system that mistake leaks
another venue's customers and revenue.

Three things make it real rather than decorative:

- **`FORCE ROW LEVEL SECURITY`, not just `ENABLE`.** The application connects as
  the role that owns these tables, and a table owner is exempt from its own
  policies unless the table is forced. Without this the policies would look
  right and do nothing.
- **Fail closed.** With no tenant context set, `current_setting` returns NULL and
  the policy denies. A request that somehow skips the tenant interceptor sees
  zero rows rather than everyone's.
- **A boot-time check.** A superuser, or a role with `BYPASSRLS`, ignores every
  policy silently. The app verifies its own role at startup and **refuses to
  start in production** if it can bypass. A service that will not boot is a much
  smaller problem than one that boots and leaks.

Each authenticated request runs in one transaction with `app.tenant_id` set,
carried through the request by `AsyncLocalStorage` so services keep taking a
plain injected `db`. That also means a handler failing partway leaves nothing
behind — no booking without its customer, no cancellation without its refund.
The cost is one pooled connection per in-flight request, which is the right
trade for an admin console.

Migrations, the seed script and the nightly job cross tenants by nature. They
opt out with an explicit `app.bypass_rls`, which is a deliberate act rather than
the accident of a missing setting — and the nightly job goes further, adopting
each tenant in turn so its work stays subject to the same policies.

### Every change is recorded

`audit_event` is append-only: row-level security permits INSERT and SELECT, and
nothing else, so the trail cannot be rewritten from the application even if it is
compromised. Entries are written on the request's own transaction, so the log
commits with the change it describes — no entry for a booking that rolled back,
and no silent change without an entry. An audit write that fails logs and moves
on; it must not turn a completed booking into a 500 for the owner at the desk.

### Timestamps

Stored as `timestamptz` in UTC; every venue carries an IANA timezone and all slot
maths happens in venue-local time. India has no DST so this buys nothing today —
but a second market would otherwise be a migration rather than a config change.

## Layout

```
backend/
  migrations/        hand-written SQL — the exclusion constraint is not
                     expressible in the ORM, and hiding it behind codegen
                     would be the wrong trade
  src/
    common/          time, money, error mapping, paid-totals aggregate
    db/              drizzle schema, migration runner, seed
    auth/            JWT sign-in, tenant scoping
    venues/          venues and courts
    pricing/         price rules and the pure resolver
    calendar/        day and week availability
    reservations/    quick-book, blocks, cancellations, status
    series/          recurring bookings and the nightly extension job
    cancellation/    tiered refund policy and the refund resolver
    payments/        the ledger
    reports/         billed, collected, outstanding
    audit/           append-only record of who did what
    public/          venue page, availability, holds, OTP identity
    payments/        the ledger, plus checkout and the payment gateway
  test/              unit tests plus the concurrency proof
frontend/
  src/
    lib/             api client, auth context, formatting
    components/      calendar cells, modals, customer picker
    pages/           calendar, bookings, customers, reports, settings
Dockerfile           multi-stage; the web bundle is baked in and served by the API
render.yaml          Render blueprint, migrations as a pre-deploy step
fly.toml             Fly config, migrations as a release_command
```

## Roadmap

**Phase 1 — the public booking page.** Where the hard parts live, and none of
them exist yet because no stranger pays online today: a `held` status with an
expiry and a sweeper, phone-OTP identity, Razorpay with the *webhook* as the
source of truth (HMAC over the raw body, event id stored for idempotency), and
the auto-refund path for a payment that lands after its hold expired.

The venue should connect **their own** Razorpay account. Pooling funds and paying
out makes you a payment facilitator, with float, reconciliation and chargebacks
attached. Be software first.

**Phase 2.** WhatsApp confirmations (template approval takes days — start early),
GST invoicing with a gapless per-tenant sequence.

**Later — halls.** Wedding and function halls sell a *date*, not an hour, and the
booking is a CRM pipeline — enquiry, site visit, quote, advance — before it is
ever a calendar entry. They reuse the `reservation` table and almost nothing else.
Two notes recorded now so they are not got wrong later: an *enquiry* must not
block the date (owners let three families race for one November date; only a
tentative hold blocks, and it expires in days not minutes), and the blocked
interval is wider than the billed one, because the decorator wants the hall the
evening before.

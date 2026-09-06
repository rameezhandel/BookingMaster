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

Hardening in place: `helmet`, a global per-IP request ceiling with a much
tighter budget on `/api/auth/login` and `/api/auth/register`, boot-time
environment validation, graceful shutdown so the connection pool drains on
`SIGTERM`, and a non-root container user.

**Not yet done, and worth knowing before this holds anyone's real data:**
row-level security over `tenant_id` (the column is there and every query is
scoped, but there is no database-level backstop for a forgotten `WHERE`), audit
logging, and backups.

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

### Multi-tenancy from the first migration

Every tenant-owned row carries `tenant_id`, and services take it as an explicit
argument so a missing scope is a compile error rather than a silent cross-tenant
read. There is exactly one customer today; adding this column to a live schema
later is genuinely miserable, and it costs nothing now.

Postgres row-level security is the intended next layer — a safety net for the one
forgotten `WHERE tenant_id`, and there will be one.

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
    payments/        the ledger
    reports/         billed, collected, outstanding
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
a cancellation-policy engine as tenant config, GST invoicing with a gapless
per-tenant sequence.

**Later — halls.** Wedding and function halls sell a *date*, not an hour, and the
booking is a CRM pipeline — enquiry, site visit, quote, advance — before it is
ever a calendar entry. They reuse the `reservation` table and almost nothing else.
Two notes recorded now so they are not got wrong later: an *enquiry* must not
block the date (owners let three families race for one November date; only a
tentative hold blocks, and it expires in days not minutes), and the blocked
interval is wider than the billed one, because the decorator wants the hall the
evening before.

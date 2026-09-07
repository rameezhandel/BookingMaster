# Architecture

Why BookingMaster is built the way it is. The short version: the database
enforces the rules that matter, and the application is not trusted to remember
them.

If you only read one section, read the first.

## Double-booking is prevented by the database, not by application code

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

## Slots are generated, never stored

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

## Pricing is data, not branches

A `price_rule` row carries a day mask, a time window, an optional date range, a
per-hour rate and a priority. The highest-priority rule covering the slot start
wins; ties break towards the narrower window, which is what an owner means when
they add "Saturday evening" on top of "Saturday". No rule matching returns
`null`, so the UI says *no price set* instead of quietly charging zero.

`resolvePrice` is a pure function with no database, because pricing is the part
owners argue about and it has to be testable.

## Money is integer paise, and payments are their own table

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

## Recurring bookings are a rule, not copied rows

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

## Cancellation refunds are policy, not arithmetic

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

## The public page shows availability and nothing else

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

## Holds, and the gap the constraint cannot see

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

## Catching an error inside a transaction is not enough

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

## Identity is a phone number

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

## The webhook decides that money arrived, not the browser

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

## Players can cancel their own bookings

Confirm the phone number, see your bookings at that venue, cancel one. The
refund is quoted from the venue's policy **before** anything is cancelled —
finding out what you get back after the slot is gone is the wrong order, and it
is what people phone up angry about.

The refund amount is always the policy's, never one the request supplies. What
happens next depends on how the booking was paid:

- **Paid through the gateway** — the money is sent back immediately, and only
  then is the refund written to the ledger. Recording it first would tell a
  customer they had been refunded when they had not.
- **Paid in cash at the counter** — there is nothing for a gateway to return.
  The response says to collect it from the venue, the ledger honestly still
  shows the money held, and the owner settles it in person.
- **The gateway refund fails** — that is money the venue owes. It is logged at
  error level with everything needed to settle by hand, and the customer is told
  the venue will arrange it rather than that it is on its way.

The slot goes back on sale before any of that: a refund that fails is money
owed, not a booking still standing.

A booking id belonging to someone else returns the same 404 as one that does not
exist, so ids cannot be probed. The session is short-lived, scoped to one venue,
and kept in `sessionStorage` rather than `localStorage` — these pages get opened
on shared and borrowed phones, so closing the tab should end it.

## Messages are queued in the same transaction as the booking

Sending inside the request is wrong three ways, and all three bite:

- The call to WhatsApp is slow and holds a database connection for its duration.
- If the send succeeds and the transaction then rolls back, a customer has been
  told about a booking that does not exist.
- If the transaction commits and the send throws, the message is gone with
  nothing to retry from.

So the message is a row, written by the same transaction that writes the
booking — atomic with the thing it describes — and a worker sends it a moment
later. A failed send is still on the table with its attempt count, waiting.
Retries back off 1, 5 then 25 minutes and then stop; a provider that will never
accept the message (a bad number, an unapproved template) is failed on the first
answer rather than retried three more times.

A worker claims a row with a conditional `UPDATE ... WHERE attempts = $seen`
before calling the provider. Claiming after sending, or not at all, is how
customers get told twice.

Due-ness is decided by the database's clock, not the worker's. `next_attempt_at`
is written by Postgres, which keeps microseconds, while a JavaScript `Date` is
truncated to milliseconds — so a row scheduled in the same millisecond as the
query reads as not-yet-due and is quietly skipped. Across several replicas the
same comparison drifts with whatever each machine thinks the time is. One clock,
and it is the one that wrote the value.

Deduplication is a unique index on `(tenant_id, dedupe_key)` and an
insert-and-catch, not a check-then-insert: two webhook retries arriving together
would both pass the check and both send.

Three reasons to say nothing, checked in one place rather than at each call site
so none of them can be forgotten: the venue has messaging off, the customer
asked not to be messaged, or there is no phone number. The customer can set that
themselves from their own bookings — an opt-out that means "phone the venue and
ask" is not really an opt-out.

**The wording has to match what happened.** A customer cancelling online is
cancelled *first* and refunded second, so the slot goes back on sale without
waiting on the gateway. That means the message cannot be queued by the cancel
itself: it would go out before the refund outcome is known. So that path
suppresses the standard message and queues its own once the refund has been
attempted — "₹500 has been refunded to your original payment method" when it
went through, and "a refund of ₹500 is due" when it did not. Telling someone
money is on its way when it is not is worse than saying nothing.

**Not verified against Meta.** The Cloud API client is written to the documented
contract but has never been run against a real account, and WhatsApp template
approval takes days. `npm run templates` prints each template ready to paste into
WhatsApp Manager; the body text there must match `src/notifications/templates.ts`
exactly or the send is rejected. With no provider configured, messages are
written to the log — and in production that is logged as an error rather than
passing quietly, because a notification system that pretends to work is worse
than one that is obviously off.

## Tenant isolation is enforced by the database

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

## The console has to work on a phone

The public page was built phone-first. The console was not — it was only ever
laid out at 1440px, and at 390px the nav ran 570px wide, so Reports, Activity
and Settings were off the right edge and untappable while the whole page panned
sideways. The person the console is for is standing at a desk with a phone in
one hand.

Three rules, applied below 700px:

- **Nothing pans the page.** Anything wider than the screen — the nav, every
  table, the calendar grid — scrolls inside its own box instead. A page that
  slides sideways loses the fixed left edge that makes a list readable.
- **A scroller says it is one.** The tables use scrolling shadows made of four
  background layers, two that scroll with the content and two that do not, so
  each shadow is covered exactly when its end is reached. That is CSS with no
  wrapper element and no scroll listener, which matters across eleven tables
  that would otherwise each need both.
- **Thumbs, not cursors.** Controls get a 40px minimum, and fields get a 16px
  font — under that, iOS Safari zooms the page on focus and does not zoom back,
  putting the rest of the form off-screen.

Modals become bottom sheets, anchored where a thumb can reach and capped at 92%
of the screen with the body scrolling inside, so the confirm button is never
below the fold.

The calendar header was the other half of it: 507px of an 844px screen went on
the date, the week strip and the day's totals before the grid began, so the
thing the page exists for started below the fold. Rearranged to 366px — the
title shares its row with the block button, the seven days fit one row, and the
three totals fit another.

## The token is not trusted about who you are

Every venue used to have exactly one login, so a manager and three desk staff
shared it. That is how the record of who did what becomes worthless, and how
someone who leaves keeps their access until a password change inconveniences
everybody at once — which is why it never happens.

Staff are invited by email. The owner names the person; the person sets their
own password, so it is known to nobody else and never travels through a chat
message. Only the invitation token's *hash* is stored, for the same reason OTP
codes are hashed: a leaked backup must not hand out working invitations. An
invitation is single-use, and it is spent in the same transaction that creates
the login, so two taps on the link cannot make two accounts.

Expired, revoked, already used and never existed all answer identically. A token
is a secret, and distinguishing the cases turns the endpoint into an oracle for
guessing them.

**A JWT is a snapshot, so role and status are read from the database on every
request.** Switching off someone who left, or demoting them, would otherwise do
nothing until their token expired hours later — and "revoked, give or take a few
hours" is not revoked. The cost is one primary-key lookup per request, which is
the right price for being able to lock someone out and mean it.

That check lives inside `JwtAuthGuard` rather than in a guard of its own,
because that guard is already on every authenticated controller. A separate
guard is one somebody forgets to add to the route they wrote on a Friday, and
the hole that leaves is invisible until it is exploited.

**Staff may do anything the day needs**; the owner-only list is short and is
about the *business* rather than the day: revenue, prices, weekly opening hours,
what the public sees, the activity log, and who else has a login. A permission
model that gets in the way at the counter is worked around by sharing the
owner's login, which is the problem this exists to solve.

The line between the two is recurring policy versus a one-off exception. Weekly
opening hours are the owner's; a closure for a flooded turf is not, because the
person who knows about the flood is standing at the desk and the owner is not
there. Staff can already block a court for rain, so allowing that but not a
venue-wide closure would only teach people to borrow the owner's password.

The split is written down as a list in `test/permissions.test.ts` and checked
against what the controllers declare, in both directions: a route that gained
the decorator by sitting next to owner-only ones fails the test, and so does an
owner-only route that lost it. Permissions drift silently otherwise — the
symptom is a person at a desk, months later, unable to do their job.

That test also asserts the reverse of a bug this had: the settings screen must
not *offer* staff a control that only ever fails for them. Every card that
writes to an owner-only route is rendered behind an owner check, and staff see
the closures card and the message log instead of five forms that 403 on save.

People are deactivated, never deleted — their bookings, payments and audit
entries all point at them, and removing the row would either take that history
with it or leave it anonymous. The last active owner cannot be switched off or
demoted, and nobody can change their own role or lock themselves out: an account
with no active owner cannot be administered by anyone.

**`app_user` moved under row-level security to make this safe.** It was
originally left out because signing in has to find a user before any tenant is
known, which made every staff query's tenant scoping a hand-written `WHERE`
with no database backstop. Fine when there was one user per tenant and nothing
to list; wrong the moment an owner can manage other people. The default is now
closed, and the two places that genuinely must cross tenants — signing in, and
redeeming an invitation, neither of which has a tenant yet — say so out loud by
bypassing.

## Every change is recorded

`audit_event` is append-only: row-level security permits INSERT and SELECT, and
nothing else, so the trail cannot be rewritten from the application even if it is
compromised. Entries are written on the request's own transaction, so the log
commits with the change it describes — no entry for a booking that rolled back,
and no silent change without an entry. An audit write that fails logs and moves
on; it must not turn a completed booking into a 500 for the owner at the desk.

## Timestamps

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
    auth/            sign-in, and the guard that reads role and account
                     status from the database rather than the token
    staff/           logins, invitations and roles
    venues/          venues and courts
    pricing/         price rules and the pure resolver
    calendar/        day and week availability
    availability/    opening hours and date overrides
    reservations/    quick-book, blocks, cancellations, status
    series/          recurring bookings and the nightly extension job
    cancellation/    tiered refund policy and the refund resolver
    payments/        the ledger, plus checkout and the payment gateway
    notifications/   the message outbox, templates and the sending worker
    reports/         billed, collected, outstanding
    audit/           append-only record of who did what
    public/          venue page, availability, holds, OTP identity
  test/              unit tests plus the concurrency, RLS, transaction and
                     permission proofs
frontend/
  src/
    lib/             api client, auth context, formatting
    components/      calendar cells, modals, customer picker
    pages/           the owner console
    public/          the booking page players see
Dockerfile           multi-stage; the web bundle is baked in and served by the API
render.yaml          Render blueprint, migrations as a pre-deploy step
fly.toml             Fly config, migrations as a release_command
```

## Roadmap

**Done — the public booking page and the money.** A `held` status with an expiry
and a sweeper, phone-OTP identity, Razorpay with the *webhook* as the source of
truth (HMAC over the raw body, event id stored for idempotency), the auto-refund
path for a payment that lands after its hold expired, self-service cancellation,
and the message outbox.

Still to do before any of that is really live: run the Razorpay and WhatsApp
integrations against real accounts. Both are written to the documented contract
and neither has ever spoken to the outside world.

The venue should connect **their own** Razorpay account. Pooling funds and paying
out makes you a payment facilitator, with float, reconciliation and chargebacks
attached. Be software first.

**Next.** GST invoicing with a gapless per-tenant sequence, delivery receipts
back from WhatsApp (`delivered` and `read` are already statuses on the row,
waiting for the status webhook to set them), and an owner's daily digest.

**Later — halls.** Wedding and function halls sell a *date*, not an hour, and the
booking is a CRM pipeline — enquiry, site visit, quote, advance — before it is
ever a calendar entry. They reuse the `reservation` table and almost nothing else.
Two notes recorded now so they are not got wrong later: an *enquiry* must not
block the date (owners let three families race for one November date; only a
tentative hold blocks, and it expires in days not minutes), and the blocked
interval is wider than the billed one, because the decorator wants the hall the
evening before.

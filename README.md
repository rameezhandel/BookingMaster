# BookingMaster

Booking software for sports venues — indoor cricket, tennis, badminton. A venue
owner runs their day on it, and their players book online from a public page.

Double-booking is prevented by a Postgres exclusion constraint rather than by
application code, which is the one design decision everything else follows from.

```sql
CONSTRAINT reservation_no_overlap EXCLUDE USING gist (
  resource_id WITH =, during WITH &&
) WHERE (status IN ('held', 'confirmed', 'completed', 'blocked'))
```

## Features

**Owner console**

- Day calendar across every court, with a week occupancy strip
- Quick-book a caller or walk-in in three taps; block time for rain or maintenance
- Opening hours per weekday, several windows a day, date overrides for holidays
- Recurring weekly bookings
- Payments in cash, UPI, card or bank transfer — part payments and refunds included
- Tiered cancellation policy, customer history, revenue reports
- WhatsApp confirmations, cancellations and reminders, with a log of what was sent
- Append-only activity log

**Public booking page** at `/v/<slug>`, no account needed

- Live availability and the price on each slot
- Phone verification by OTP, with the slot held while the player books
- Pay online, or at the court where the venue prefers it
- Players see and cancel their own bookings, with the refund quoted first

## Quick start

Node 20+ and Postgres 16+.

```bash
git clone https://github.com/rameezhandel/BookingMaster.git
cd BookingMaster

docker compose up -d db                 # or point at your own Postgres
cp backend/.env.example backend/.env    # set DATABASE_URL and JWT_SECRET

npm install
npm run migrate
npm run seed                            # optional demo venue, courts and bookings
npm run dev                             # API on :3000, web on :5173
```

Open <http://localhost:5173>. With the seed, sign in as `owner@smasharena.test` /
`bookingmaster`; otherwise sign up and the first-run screen creates your venue.

The migration runs `CREATE EXTENSION btree_gist`, so the database must allow it.

## Configuration

`backend/.env`, from [`.env.example`](backend/.env.example).

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres 16+, with `btree_gist` available |
| `JWT_SECRET` | yes | `openssl rand -hex 32`. The app refuses to start if it is missing, short, or still the example value |
| `TRUST_PROXY` | no | `true` only behind a proxy. Otherwise any client can forge `X-Forwarded-For` and walk around the rate limiter |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` | no | Unset means a stub gateway that moves no money |
| `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_ACCESS_TOKEN` | no | Unset means messages are written to the log instead of sent |

The database role **must not** be a superuser and must not have `BYPASSRLS` —
either one silently disables tenant isolation. The app checks its own role at
startup and refuses to boot in production if it can bypass.

## Tests

```bash
npm test        # 128 tests; the integration ones need DATABASE_URL
```

Includes a concurrency proof that races 20 connections at one slot and asserts
exactly one wins, row-level-security tests that try to read across tenants, and
webhook signature tests over raw bytes.

## Deploying

The API serves the built web bundle, so it is one container and one origin.

```bash
docker compose --profile app up --build
```

Blueprints for [Render](render.yaml) and [Fly](fly.toml) are included; both run
migrations as a release step. See [docs/DEPLOYING.md](docs/DEPLOYING.md).

## Project layout

```text
backend/
  migrations/     hand-written SQL — the exclusion constraint is not
                  expressible in the ORM
  src/            NestJS: auth, venues, pricing, calendar, reservations,
                  series, cancellation, payments, public, notifications, audit
  test/           unit tests plus the concurrency and RLS proofs
frontend/         React + Vite: owner console and the public booking page
docs/             architecture and deployment notes
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — why it is built this way, and the
  roadmap
- [Deploying](docs/DEPLOYING.md) — production configuration and hardening

## Status

Working software, not yet run against real venues. Two integrations are written
to their documented contracts but have never spoken to the live services:
**Razorpay** and the **WhatsApp Cloud API**. Verify both against test accounts
before taking real money or messaging real customers.

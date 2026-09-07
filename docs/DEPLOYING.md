# Deploying

The API serves the built web bundle, so the whole thing is **one container and
one origin** — no CORS in the request path and no second service to keep in sync.

```bash
docker compose --profile app up --build      # the full stack, locally
```

## Choosing a host

Blueprints exist for both, and the Dockerfile is the same either way, so this is
not a decision you are stuck with — moving later costs a deploy, not a rewrite.

**Render** is the better default for one person running this. Its Postgres is
managed, with backups as part of the product rather than a thing you set up;
this database holds bookings and payment records, and a lost one ends the
business. Its nearest region to India is Singapore.

**Fly** has a Mumbai region, which is worth tens of milliseconds to a player
opening the booking page on mobile data. Historically its Postgres has been an
app you run and back up yourself — check the current state, since that offering
has been changing. Take Fly when latency becomes a real complaint, or when you
want the control.

Latency is unlikely to be why a venue does not sign up. A lost database would
be. Start on Render.

## Free tiers, and what stops working on one

A sleeping free tier is a fine way to prove a deploy works. Sign in, book a
slot, take a payment, issue an invoice — all of it behaves. Use one for that.

What it will not do is run the clock. Everything in the next section stops while
the instance is asleep, so on a free tier:

- queued WhatsApp messages sit there until something wakes the instance
- expired holds are never swept, so slots stay blocked after their timer runs out
- the reminder before a booking never fires
- the 3am and 4am jobs never happen at all

None of that is broken. If you test the notification flow on a sleeping instance
and nothing arrives, that is the tier, not the code — which is worth knowing
before spending an evening on it.

Two other things about Render's free tier specifically. Waking takes something
like 30 to 60 seconds, which is long enough that a first request reads as the
site being down. And its free Postgres has had an expiry window after which the
database is removed — check the current terms before putting anything in it you
would mind losing.

**Move to a paid plan the day you show it to a venue owner.** That is a plan
change rather than a migration. Note that the blueprint asks for `starter`, so
choosing free means overriding it in the dashboard — remember that, or a later
blueprint re-apply will quietly put you back on paid.

## One instance must always be running

Once real bookings depend on it, this is not a web service that can scale to
zero. Six jobs need a live process:

| | |
| --- | --- |
| every 30s | sweep expired holds |
| every 10s | send queued WhatsApp messages |
| every 5m | queue reminders |
| hourly | hold housekeeping |
| 3am | extend recurring bookings |
| 4am | purge old message records |

With nothing running, none of them happen. Expired holds keep blocking slots
that are actually free, confirmations sit unsent, and the reminder before a 7am
game never fires — and nothing reports any of it. It reads as an app that works
erratically.

`fly.toml` therefore sets `min_machines_running = 1`. Machines beyond the first
still stop when idle, which is the saving worth having.

Running several instances is safe: every job takes a Postgres advisory lock
before doing anything, so only one of them does the work and the rest skip.

## The blueprints

Blueprints are included for [Render](render.yaml) and [Fly](fly.toml). Both run
migrations as a **release step**, not on instance boot: with more than one
replica, boot-time migration means every replica races the same DDL. The
`MIGRATE_ON_BOOT` env var exists for single-instance and local use only.

The release step is `node backend/dist/db/migrate.js`, and it reaches the
container as arguments to the entrypoint. The entrypoint runs them instead of
the server — a detail worth stating because getting it wrong is invisible until
a deploy: an entrypoint that ignores its arguments starts a second server, so
the release machine never exits and the deploy goes out with the migrations
unapplied. CI builds the image and checks it on every pull request.

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

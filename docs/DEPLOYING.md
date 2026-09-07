# Deploying

The API serves the built web bundle, so the whole thing is **one container and
one origin** — no CORS in the request path and no second service to keep in sync.

```bash
docker compose --profile app up --build      # the full stack, locally
```

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

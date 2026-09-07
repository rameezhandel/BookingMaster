#!/bin/sh
set -e

# A command passed to `docker run` replaces the server rather than preceding it.
#
# This is how migrations run as a release step, and it is not optional: Fly's
# release_command and Render's preDeployCommand both arrive here as arguments.
# An entrypoint that ignores them boots a second copy of the server instead,
# which on Fly means a release machine that never exits and a deploy that goes
# out with the migrations unapplied.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# Migrations on boot are opt-in and for a single instance only. With more than
# one replica, every one of them would race the same DDL on deploy.
if [ "$MIGRATE_ON_BOOT" = "true" ]; then
  echo "Running migrations..."
  node backend/dist/db/migrate.js
fi

if [ "$SEED_ON_BOOT" = "true" ]; then
  echo "Seeding demo data..."
  node backend/dist/db/seed.js
fi

exec node backend/dist/main.js

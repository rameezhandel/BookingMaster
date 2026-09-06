#!/bin/sh
set -e

# Migrations are opt-in rather than automatic. With more than one instance
# running, every replica would otherwise race the same DDL on deploy. Prefer a
# release step:  docker run --rm <image> node backend/dist/db/migrate.js
if [ "$MIGRATE_ON_BOOT" = "true" ]; then
  echo "Running migrations..."
  node backend/dist/db/migrate.js
fi

if [ "$SEED_ON_BOOT" = "true" ]; then
  echo "Seeding demo data..."
  node backend/dist/db/seed.js
fi

exec node backend/dist/main.js

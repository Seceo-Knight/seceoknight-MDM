#!/bin/sh
# SeceoKnight MDM — automatic migration runner.
# Runs inside the db-migrate container on every `docker compose up`.
# Tracks applied migrations in a _migrations table so only new files run.
set -e

PGHOST="${PGHOST:-postgres}"
PGUSER="${PGUSER:-mdm}"
PGPASSWORD="${PGPASSWORD:-mdm}"
PGDB="${PGDB:-mdm}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"

export PGPASSWORD

echo "==> Waiting for postgres at $PGHOST..."
until pg_isready -h "$PGHOST" -U "$PGUSER" -d "$PGDB" -q; do
  sleep 1
done
echo "==> Postgres ready."

# Create migration-tracking table if it doesn't exist yet.
psql -h "$PGHOST" -U "$PGUSER" -d "$PGDB" -c "
  CREATE TABLE IF NOT EXISTS _migrations (
    name       TEXT        PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
" > /dev/null

echo "==> Checking for pending migrations..."

# Apply every *.sql file in sorted order, skipping already-applied ones.
applied=0
skipped=0

for filepath in $(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort); do
  name=$(basename "$filepath")

  # Check if this migration has already been applied.
  count=$(psql -h "$PGHOST" -U "$PGUSER" -d "$PGDB" -tAc \
    "SELECT COUNT(*) FROM _migrations WHERE name = '$name'")

  if [ "$count" = "0" ]; then
    echo "    [RUN]  $name"
    psql -h "$PGHOST" -U "$PGUSER" -d "$PGDB" -f "$filepath"
    psql -h "$PGHOST" -U "$PGUSER" -d "$PGDB" -c \
      "INSERT INTO _migrations (name) VALUES ('$name')" > /dev/null
    applied=$((applied + 1))
  else
    echo "    [SKIP] $name (already applied)"
    skipped=$((skipped + 1))
  fi
done

echo "==> Done. Applied: $applied  Skipped: $skipped"

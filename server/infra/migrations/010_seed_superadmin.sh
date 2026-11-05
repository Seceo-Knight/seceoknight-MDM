#!/bin/sh
# 010_seed_superadmin.sh
# -----------------------------------------------------------------------------
# Seeds the initial super-admin user from environment variables instead of a
# hardcoded SQL hash. Runs ONCE, automatically, the first time the database is
# initialized (Postgres executes every file in /docker-entrypoint-initdb.d on an
# empty data dir — this .sh runs right after 009_seed.sql, so the default tenant
# already exists).
#
# Credentials come from the env (set in docker-compose.yml / server/.env):
#   SUPERADMIN_EMAIL     (default admin@mdm.local)
#   SUPERADMIN_PASSWORD  (default ChangeMe!123)
#
# The password is hashed with bcrypt cost 12 *inside Postgres* via pgcrypto's
# crypt()/gen_salt('bf', 12) — the resulting $2a$ hash verifies fine against the
# Go service's golang.org/x/crypto/bcrypt (shared/auth/password.go, cost 12).
# Nothing is written to disk in plaintext and no secret is baked into an image.
#
# NOTE: this only runs on a FRESH database (empty ./infra/pgdata). To change the
# login on an already-initialized stack, either reset ./infra/pgdata or update
# the user manually — see server/README.md.
set -e

SUPERADMIN_EMAIL="${SUPERADMIN_EMAIL:-admin@mdm.local}"
SUPERADMIN_PASSWORD="${SUPERADMIN_PASSWORD:-ChangeMe!123}"

echo "010_seed_superadmin: seeding super-admin <${SUPERADMIN_EMAIL}>"

# -v passes the values as psql variables; :'name' interpolates them as properly
# quoted/escaped SQL string literals, so passwords with special characters (and
# any quoting) are handled safely without shell/SQL injection.
psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     -v email="$SUPERADMIN_EMAIL" \
     -v password="$SUPERADMIN_PASSWORD" <<'EOSQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES
    (
      '00000000-0000-0000-0000-000000000010'::uuid,
      '00000000-0000-0000-0000-000000000001'::uuid,
      :'email',
      crypt(:'password', gen_salt('bf', 12)),
      'super_admin'
    )
ON CONFLICT (tenant_id, email) DO NOTHING;
EOSQL

echo "010_seed_superadmin: done"

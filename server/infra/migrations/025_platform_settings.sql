-- 025_platform_settings.sql
-- Global (cross-tenant) platform settings. Singleton row enforced by a fixed
-- primary key (id = TRUE) + a CHECK, so there is exactly one row for the whole
-- deployment. Today it holds the global "debug unlock" password used by the
-- agent's hidden in-app config panel (operator types it on-device to repoint
-- the server address while the server is unreachable). The password is
-- delivered to devices as a hash, never the plaintext.
CREATE TABLE IF NOT EXISTS platform_settings (
  id                    BOOLEAN PRIMARY KEY DEFAULT TRUE,
  debug_unlock_password TEXT        NOT NULL DEFAULT '',
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            UUID,
  CONSTRAINT platform_settings_singleton CHECK (id)
);

-- Seed the single row so GET always has something to read.
INSERT INTO platform_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

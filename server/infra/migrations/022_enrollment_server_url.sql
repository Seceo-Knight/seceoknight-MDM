-- 022_enrollment_server_url.sql
-- Per-tenant server base URL baked into the QR's admin-extras `server_url`, so
-- enrolled devices phone home to a reachable address (a LAN IP or domain)
-- instead of the service default (http://localhost). Blank ⇒ fall back to the
-- service's PUBLIC_BASE_URL.

ALTER TABLE enrollment_config ADD COLUMN IF NOT EXISTS server_base_url TEXT NOT NULL DEFAULT '';

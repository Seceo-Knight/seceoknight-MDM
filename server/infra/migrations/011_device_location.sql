-- 011_device_location.sql
-- Persist the last-known location reported by the agent in the device row so
-- the admin UI can render it on each heartbeat without a per-device join.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_latitude  DOUBLE PRECISION;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_longitude DOUBLE PRECISION;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_location_accuracy_m REAL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_location_at TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_ip_address  TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_mac_address TEXT;

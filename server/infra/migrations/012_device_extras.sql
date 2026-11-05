-- Extends the per-device snapshot the admin UI renders. Each column is
-- updated opportunistically by /devices/me/heartbeat (every 60s from the
-- agent), so the values shown in the admin "Device info" card stay fresh
-- between FETCH_DEVICE_INFO commands.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_battery_pct       INT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_charging          BOOLEAN;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_vpn_active        BOOLEAN;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_storage_free_bytes BIGINT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_wifi_ssid         TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_network_type      TEXT;

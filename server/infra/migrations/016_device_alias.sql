-- 016_device_alias.sql
-- Human-friendly device alias. Everything in the platform keys off the opaque
-- device UUID; an alias gives operators a memorable label ("Reception iPad",
-- "Warehouse scanner #3") shown wherever a device is referenced. Editing it is
-- gated to super_admin/admin in the device-service handler — the column itself
-- is just free text.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS alias TEXT;

-- Case-insensitive lookup so operators can search by alias the same way they
-- search by serial/model.
CREATE INDEX IF NOT EXISTS idx_devices_alias ON devices (tenant_id, lower(alias));

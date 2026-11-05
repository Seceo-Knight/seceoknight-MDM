-- 019_device_snapshots.sql
-- Append-only point-in-time history of device state, powering "fleet
-- time-travel" (reconstruct what a device/the fleet looked like at any past
-- instant). The live `devices` row is mutated in place by heartbeats, so it
-- only holds the latest value; this table keeps the history. A snapshot is
-- written on heartbeat, throttled to at most one row per device every ~2 min
-- to bound volume (see device_repo.SnapshotNow).

CREATE TABLE IF NOT EXISTS device_snapshots (
    id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    device_id              UUID NOT NULL,
    captured_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    state                  TEXT,
    mgmt_mode              TEXT,
    applied_policy_version INT,
    battery_pct            INT,
    charging               BOOLEAN,
    network_type           TEXT,
    wifi_ssid              TEXT,
    ip_address             TEXT,
    latitude               DOUBLE PRECISION,
    longitude              DOUBLE PRECISION,
    accuracy_m             REAL
);

-- "this device's state as-of T" and series queries:
CREATE INDEX IF NOT EXISTS idx_device_snapshots_dev_time
    ON device_snapshots (tenant_id, device_id, captured_at DESC);
-- "the whole fleet as-of T":
CREATE INDEX IF NOT EXISTS idx_device_snapshots_time
    ON device_snapshots (tenant_id, captured_at DESC);

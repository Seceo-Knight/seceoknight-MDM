-- 006_telemetry.sql
-- Telemetry is high-volume and append-only. We partition by month so retention
-- policies can drop old partitions cheaply.

CREATE TABLE IF NOT EXISTS telemetry_events (
    id           UUID NOT NULL DEFAULT uuid_generate_v4(),
    tenant_id    UUID NOT NULL,
    device_id    UUID NOT NULL,
    kind         TEXT NOT NULL,            -- heartbeat, app_inventory, battery, network, ...
    payload      JSONB NOT NULL,
    captured_at  TIMESTAMPTZ NOT NULL,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);

-- Bootstrap with current + next month partitions. Real deployments add a
-- cron/pg_partman job to roll partitions forward.
CREATE TABLE IF NOT EXISTS telemetry_events_default PARTITION OF telemetry_events DEFAULT;

CREATE INDEX IF NOT EXISTS idx_telemetry_device_time ON telemetry_events(device_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_kind_time  ON telemetry_events(kind, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_tenant     ON telemetry_events(tenant_id);

-- Latest snapshot per kind per device — fast lookup for dashboards.
CREATE TABLE IF NOT EXISTS device_telemetry_latest (
    device_id    UUID NOT NULL,
    kind         TEXT NOT NULL,
    tenant_id    UUID NOT NULL,
    payload      JSONB NOT NULL,
    captured_at  TIMESTAMPTZ NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, kind)
);

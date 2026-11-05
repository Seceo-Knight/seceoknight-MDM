-- 003_devices.sql
-- Devices, enrollment tokens, device groups.

CREATE TABLE IF NOT EXISTS device_groups (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ,
    UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS enrollment_tokens (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    policy_id   UUID,
    token       TEXT NOT NULL UNIQUE,
    one_shot    BOOLEAN NOT NULL DEFAULT true,
    used_count  INTEGER NOT NULL DEFAULT 0,
    max_uses    INTEGER NOT NULL DEFAULT 1,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_by  UUID NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_enrollment_token ON enrollment_tokens(token);

CREATE TABLE IF NOT EXISTS devices (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    enrollment_token_id     UUID REFERENCES enrollment_tokens(id),
    serial_number           TEXT,
    imei                    TEXT,
    android_id              TEXT,
    manufacturer            TEXT,
    model                   TEXT,
    os_version              TEXT,
    security_patch_level    TEXT,
    state                   TEXT NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('pending','enrolled','offline','wiped','retired')),
    last_heartbeat_at       TIMESTAMPTZ,
    assigned_policy_id      UUID,
    applied_policy_version  INTEGER NOT NULL DEFAULT 0,
    group_id                UUID REFERENCES device_groups(id),
    tags                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at              TIMESTAMPTZ,
    version                 INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_devices_tenant_state ON devices(tenant_id, state) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_devices_serial ON devices(tenant_id, serial_number) WHERE serial_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_devices_group ON devices(group_id);
CREATE INDEX IF NOT EXISTS idx_devices_heartbeat ON devices(last_heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_devices_tags_gin ON devices USING gin (tags);

DROP TRIGGER IF EXISTS trg_devices_updated ON devices;
CREATE TRIGGER trg_devices_updated BEFORE UPDATE ON devices
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

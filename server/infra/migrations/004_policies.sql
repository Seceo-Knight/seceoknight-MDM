-- 004_policies.sql
-- Versioned policy documents. `spec` holds the full PolicySpec JSON, mirroring
-- the schema the Android agent's policy-engine consumes. We retain prior
-- versions so devices on slower update cadences can still resolve their last
-- applied version.

CREATE TABLE IF NOT EXISTS policies (
    id          UUID NOT NULL DEFAULT uuid_generate_v4(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    spec        JSONB NOT NULL,
    created_by  UUID NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ,
    PRIMARY KEY (id, version),
    UNIQUE (tenant_id, name, version)
);

CREATE INDEX IF NOT EXISTS idx_policies_tenant ON policies(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_policies_latest ON policies(id, version DESC);

-- Now back-fill the FK on devices for assigned_policy_id; pointed at policy
-- head row (smallest version that still exists; deletion handled in app layer).
ALTER TABLE devices
    ADD CONSTRAINT fk_devices_policy
    FOREIGN KEY (assigned_policy_id, applied_policy_version)
    REFERENCES policies(id, version)
    ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED;

DROP TRIGGER IF EXISTS trg_policies_updated ON policies;
CREATE TRIGGER trg_policies_updated BEFORE UPDATE ON policies
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Assignment mapping table — supports many devices/group -> one policy.
CREATE TABLE IF NOT EXISTS policy_assignments (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    policy_id   UUID NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('device','group','tenant')),
    target_id   UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assign_target ON policy_assignments(target_kind, target_id);

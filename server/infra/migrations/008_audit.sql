-- 008_audit.sql
-- Append-only, hash-chained audit log. Each row's `hash` is sha256(prev_hash ||
-- canonical_json(row)), enforced in application code; the DB just guarantees
-- INSERT-only via REVOKE.

CREATE TABLE IF NOT EXISTS audit_entries (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    actor_id    UUID,
    actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('user','device','system')),
    action      TEXT NOT NULL,
    target_kind TEXT,
    target_id   UUID,
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    prev_hash   TEXT NOT NULL DEFAULT '',
    hash        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_entries(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_entries(target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_entries(actor_id);

-- Reject UPDATE/DELETE at the DB level. (App writes via a low-privilege role.)
CREATE OR REPLACE FUNCTION audit_no_modify()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_entries is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_no_update ON audit_entries;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE OR DELETE ON audit_entries
FOR EACH ROW EXECUTE FUNCTION audit_no_modify();

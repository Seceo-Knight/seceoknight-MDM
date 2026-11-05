-- 002_users_auth.sql
-- Admin/operator users, refresh tokens with rotation, RBAC roles.

CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email           CITEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('super_admin','admin','operator','viewer')),
    mfa_enabled     BOOLEAN NOT NULL DEFAULT false,
    mfa_secret      TEXT,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,
    UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_users_updated ON users;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Refresh tokens (hashed). Rotation: each /refresh creates a new row and sets
-- the previous row's replaced_by + revoked_at. Reuse of a revoked token must
-- revoke the whole chain (handled in application code).
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subject_id   UUID NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('user','device')),
    token_hash   TEXT NOT NULL UNIQUE,
    issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ,
    replaced_by  UUID REFERENCES refresh_tokens(id),
    user_agent   TEXT,
    ip_addr      TEXT
);

CREATE INDEX IF NOT EXISTS idx_refresh_subject ON refresh_tokens(subject_id, kind);
CREATE INDEX IF NOT EXISTS idx_refresh_active ON refresh_tokens(token_hash) WHERE revoked_at IS NULL;

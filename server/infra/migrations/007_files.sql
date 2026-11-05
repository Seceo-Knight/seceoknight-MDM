-- 007_files.sql
-- File / APK metadata. The bytes live in MinIO under storage_key.

CREATE TABLE IF NOT EXISTS file_objects (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('apk','log','generic','config')),
    storage_key   TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    size_bytes    BIGINT NOT NULL,
    content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
    uploaded_by   UUID NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_files_tenant ON file_objects(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_files_kind ON file_objects(kind);
CREATE INDEX IF NOT EXISTS idx_files_sha ON file_objects(sha256);

-- App catalog — APKs we may deploy. Different from a plain file because we
-- track package name + signing certificate per record.
CREATE TABLE IF NOT EXISTS app_catalog (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    file_id         UUID NOT NULL REFERENCES file_objects(id),
    package_name    TEXT NOT NULL,
    version_code    BIGINT NOT NULL,
    version_name    TEXT NOT NULL,
    signing_cert_sha256 TEXT NOT NULL,
    min_sdk         INTEGER,
    target_sdk      INTEGER,
    label           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, package_name, version_code)
);

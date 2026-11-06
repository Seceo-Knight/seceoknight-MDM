-- SeceoKnight MDM — Fleet Package Blocklist
-- Admins can add any package name to this list to flag devices that have it
-- installed. The compliance engine and AI engine cross-reference this list.
-- Blocking enforcement is applied via policy (AppPolicy.BlockedPackages).

CREATE TABLE IF NOT EXISTS fleet_blocked_packages (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL,
  package_name TEXT         NOT NULL,
  display_name TEXT         NOT NULL DEFAULT '',  -- friendly label shown in UI
  reason       TEXT         NOT NULL DEFAULT '',  -- why this package is blocked
  created_by   UUID,                              -- user UUID who added the entry
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, package_name)
);

CREATE INDEX IF NOT EXISTS idx_blocked_packages_tenant ON fleet_blocked_packages(tenant_id);

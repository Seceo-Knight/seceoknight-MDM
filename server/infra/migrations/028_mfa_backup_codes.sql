-- Migration 028: Add MFA backup codes column
-- Apply: docker exec -i server-postgres-1 psql -U mdm -d mdm < migration.sql

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_backup_codes TEXT[] NOT NULL DEFAULT '{}';

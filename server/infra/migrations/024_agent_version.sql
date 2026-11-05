-- 024_agent_version.sql
-- Live agent build, reported by the device on every heartbeat so the dashboard
-- always shows the current version (not just after a FETCH_DEVICE_INFO).
--   agent_version       — human versionName (e.g. "1.0.0")
--   agent_version_code  — versionCode (bumps every build → proves an update)

ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_version TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_version_code BIGINT;

-- 017_device_mgmt_mode.sql
-- Tracks the agent's current privilege level so the dashboard reflects it live.
-- The agent reports one of 'owner' (Device Owner), 'admin' (Device Admin) or
-- 'none' (enrolled, no admin/owner) on every heartbeat. Because it rides the
-- 60s heartbeat (not a one-shot FETCH_DEVICE_INFO), promoting an enrolled-only
-- install to Device Admin/Owner shows up in the UI automatically within a
-- minute — no manual refresh.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_mgmt_mode TEXT;

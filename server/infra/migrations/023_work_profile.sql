-- 023_work_profile.sql
-- Work Profile / BYOD (Android Profile Owner) enrollment mode.
--
-- 1. enrollment_tokens.provisioning_mode — selects the Android flow the token
--    drives: 'device_owner' (fully-managed, default), 'work_profile' (BYOD
--    Profile Owner) or 'device_admin' (legacy). Existing tokens keep the
--    fully-managed behaviour via the DEFAULT.
-- 2. devices.enrollment_channel — HOW the device enrolled
--    ('qr_setup' | 'qr_inapp' | 'direct_install' | 'adb'); NULL for devices
--    enrolled before this column existed.
-- 3. devices.management_mode — the role the agent holds
--    ('device_owner' | 'profile_owner' | 'device_admin'); NULL when unknown.

ALTER TABLE enrollment_tokens
    ADD COLUMN IF NOT EXISTS provisioning_mode TEXT NOT NULL DEFAULT 'device_owner';

ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS enrollment_channel TEXT;

ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS management_mode TEXT;

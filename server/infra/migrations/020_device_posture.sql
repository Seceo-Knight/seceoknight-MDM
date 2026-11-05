-- 020_device_posture.sql
-- Continuous attestation: the agent reports integrity signals (rooted,
-- debuggable, emulator, adb, secure-lock) on every heartbeat; the server
-- computes a 0-100 posture score and stores it on the device, which becomes the
-- conditional-access primitive (compliant = score >= tenant threshold).

ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_posture_score   INT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_posture_factors JSONB;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_posture_at      TIMESTAMPTZ;

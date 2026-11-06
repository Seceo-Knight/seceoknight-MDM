-- SeceoKnight MDM — AI Anomaly Detection
-- Stores per-device statistical baselines and detected anomalies.
-- The anomaly engine (telemetry-service background goroutine) writes here
-- every 5 minutes; the admin UI reads from these tables to show AI insights.

-- Rolling statistical baseline per device — updated each engine run.
CREATE TABLE IF NOT EXISTS device_baselines (
  device_id       UUID         PRIMARY KEY,
  tenant_id       UUID         NOT NULL,
  -- Battery statistics (from last 7 days of heartbeat samples)
  battery_avg     DOUBLE PRECISION,
  battery_std     DOUBLE PRECISION,
  battery_samples INT          NOT NULL DEFAULT 0,
  -- Posture score statistics
  posture_avg     DOUBLE PRECISION,
  posture_std     DOUBLE PRECISION,
  posture_samples INT          NOT NULL DEFAULT 0,
  -- Heartbeat interval statistics (seconds between heartbeats)
  hb_interval_avg DOUBLE PRECISION,
  hb_interval_std DOUBLE PRECISION,
  hb_samples      INT          NOT NULL DEFAULT 0,
  -- Storage free bytes statistics
  storage_avg     DOUBLE PRECISION,
  storage_std     DOUBLE PRECISION,
  storage_samples INT          NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_baselines_tenant ON device_baselines(tenant_id);

-- Detected anomalies — one row per detected threat event.
-- The engine de-duplicates: same device + same type within a 1-hour window
-- does NOT create a new row (cooldown). Resolved automatically when the
-- condition normalises.
CREATE TABLE IF NOT EXISTS device_anomalies (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL,
  device_id     UUID         NOT NULL,
  -- Anomaly classification
  anomaly_type  TEXT         NOT NULL,   -- battery_drain | posture_drop | offline_spike | location_jump | app_burst | storage_drop
  severity      TEXT         NOT NULL CHECK (severity IN ('info','warning','critical')),
  -- Z-score that triggered this anomaly (how many standard deviations from baseline)
  z_score       DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- Human-readable description for the UI
  description   TEXT         NOT NULL,
  -- Raw numbers for drill-down
  details       JSONB        NOT NULL DEFAULT '{}',
  resolved      BOOLEAN      NOT NULL DEFAULT FALSE,
  resolved_at   TIMESTAMPTZ,
  detected_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_anomalies_tenant_time  ON device_anomalies(tenant_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_anomalies_device       ON device_anomalies(device_id,  detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_anomalies_unresolved   ON device_anomalies(tenant_id, resolved, detected_at DESC);

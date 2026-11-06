-- 032_alert_anomaly_subscription.sql
-- Add AI anomaly subscription to notification channels.

ALTER TABLE notification_channels
  ADD COLUMN IF NOT EXISTS on_anomaly_critical BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS on_anomaly_warning  BOOLEAN NOT NULL DEFAULT FALSE;

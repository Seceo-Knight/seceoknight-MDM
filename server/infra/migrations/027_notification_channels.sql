-- 027_notification_channels.sql
-- Email / Webhook Alert Channels.
-- Admins configure one or more delivery channels per tenant. When a compliance
-- rule fires (or other system events occur), the alert-service fans the event
-- out to every enabled channel for that tenant.
--
-- Tables:
--   notification_channels  — channel definitions (SMTP or Webhook)
--   notification_log        — delivery history (success + failure records)

CREATE TABLE IF NOT EXISTS notification_channels (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL,

  name        TEXT        NOT NULL,         -- human label, e.g. "Ops Slack"
  kind        TEXT        NOT NULL,         -- 'email' | 'webhook'

  -- ── Email (kind = 'email') ───────────────────────────────────────────────
  smtp_host   TEXT        NOT NULL DEFAULT '',
  smtp_port   INTEGER     NOT NULL DEFAULT 587,
  smtp_tls    BOOLEAN     NOT NULL DEFAULT TRUE,  -- STARTTLS / implicit TLS
  smtp_user   TEXT        NOT NULL DEFAULT '',
  smtp_pass   TEXT        NOT NULL DEFAULT '',    -- stored as-is; use app-passwords
  smtp_from   TEXT        NOT NULL DEFAULT '',
  smtp_to     TEXT[]      NOT NULL DEFAULT '{}',  -- recipient list

  -- ── Webhook (kind = 'webhook') ───────────────────────────────────────────
  webhook_url     TEXT    NOT NULL DEFAULT '',
  -- Optional HMAC-SHA256 signing secret. When set, the alert-service adds an
  -- X-SeceoKnight-Signature header so receivers can verify authenticity.
  webhook_secret  TEXT    NOT NULL DEFAULT '',

  -- ── Event subscriptions ──────────────────────────────────────────────────
  on_compliance_trigger BOOLEAN NOT NULL DEFAULT TRUE,   -- compliance rule fired
  on_device_offline     BOOLEAN NOT NULL DEFAULT FALSE,  -- device heartbeat lost
  on_posture_drop       BOOLEAN NOT NULL DEFAULT FALSE,  -- posture score decreased

  enabled     BOOLEAN     NOT NULL DEFAULT TRUE,

  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_channels_tenant_idx
  ON notification_channels(tenant_id);

CREATE OR REPLACE FUNCTION set_notification_channels_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_notification_channels_updated_at ON notification_channels;
CREATE TRIGGER trg_notification_channels_updated_at
  BEFORE UPDATE ON notification_channels
  FOR EACH ROW EXECUTE FUNCTION set_notification_channels_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- notification_log — append-only delivery record. Kept for 90 days max (prune
-- via a cron or pg_partman; for now we cap the UI query to 500 rows).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  UUID        REFERENCES notification_channels(id) ON DELETE SET NULL,
  tenant_id   UUID        NOT NULL,

  event_type  TEXT        NOT NULL,  -- compliance_trigger | device_offline | posture_drop | test
  subject     TEXT        NOT NULL DEFAULT '',
  payload     JSONB       NOT NULL DEFAULT '{}',

  status      TEXT        NOT NULL DEFAULT 'sent',  -- sent | failed
  error       TEXT        NOT NULL DEFAULT '',

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_log_channel_idx ON notification_log(channel_id);
CREATE INDEX IF NOT EXISTS notification_log_tenant_idx  ON notification_log(tenant_id);
CREATE INDEX IF NOT EXISTS notification_log_created_idx ON notification_log(created_at DESC);

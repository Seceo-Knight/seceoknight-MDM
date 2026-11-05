-- 026_compliance_rules.sql
-- Compliance Automation Engine — automatically take action (LOCK, WIPE, etc.)
-- when a device's posture score (or other metric) drops below a configured threshold.
--
-- compliance_rules  — admin-defined rules, one row per rule.
-- compliance_rule_events — append-only log of every evaluation that fired or
--   was skipped (cooldown). Referenced by the UI events log and by the engine
--   to enforce per-device cooldowns.

CREATE TABLE IF NOT EXISTS compliance_rules (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL,

  name             TEXT        NOT NULL,
  description      TEXT        NOT NULL DEFAULT '',

  -- What metric to watch. Supported values:
  --   posture_score   — devices.last_posture_score (0-100; lower = worse)
  --   battery_level   — devices.battery_level (0-100; lower = worse)
  trigger_field    TEXT        NOT NULL DEFAULT 'posture_score',

  -- Comparison operator: lt | lte | gt | gte | eq
  operator         TEXT        NOT NULL DEFAULT 'lt',

  -- Numeric threshold, e.g. 60 means "score < 60"
  threshold        NUMERIC(10,4) NOT NULL,

  -- Command to dispatch when the rule fires. Must be a valid command kind
  -- (from command-service types: LOCK, WIPE, REBOOT, ENABLE_LOST_MODE, etc.)
  action           TEXT        NOT NULL DEFAULT 'LOCK',

  -- Optional JSON payload forwarded to the command (e.g. {"message": "…"}).
  action_payload   JSONB       NOT NULL DEFAULT '{}',

  -- Minimum minutes between actions on the same device for this rule.
  -- Prevents spam-commanding a device that is permanently below threshold.
  cooldown_minutes INTEGER     NOT NULL DEFAULT 60,

  enabled          BOOLEAN     NOT NULL DEFAULT TRUE,

  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS compliance_rules_tenant_idx ON compliance_rules(tenant_id);
CREATE INDEX IF NOT EXISTS compliance_rules_enabled_idx ON compliance_rules(enabled) WHERE enabled = TRUE;

-- Automatic updated_at trigger.
CREATE OR REPLACE FUNCTION set_compliance_rules_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_compliance_rules_updated_at ON compliance_rules;
CREATE TRIGGER trg_compliance_rules_updated_at
  BEFORE UPDATE ON compliance_rules
  FOR EACH ROW EXECUTE FUNCTION set_compliance_rules_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- compliance_rule_events — every time the engine evaluated a rule against a
-- device.  status = 'triggered' means a command was dispatched; 'skipped' means
-- it was within the cooldown window; 'failed' means dispatch failed.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_rule_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         UUID        NOT NULL REFERENCES compliance_rules(id) ON DELETE CASCADE,
  device_id       UUID        NOT NULL,
  tenant_id       UUID        NOT NULL,

  -- The actual metric value that triggered/skipped the evaluation
  trigger_value   NUMERIC(10,4),

  action          TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'triggered', -- triggered | skipped | failed

  command_id      UUID,       -- populated when status = 'triggered'
  note            TEXT        NOT NULL DEFAULT '',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS compliance_events_rule_idx   ON compliance_rule_events(rule_id);
CREATE INDEX IF NOT EXISTS compliance_events_device_idx ON compliance_rule_events(device_id);
CREATE INDEX IF NOT EXISTS compliance_events_tenant_idx ON compliance_rule_events(tenant_id);
-- Engine uses this to find the last event for a device+rule pair (cooldown check)
CREATE INDEX IF NOT EXISTS compliance_events_device_rule_idx
  ON compliance_rule_events(device_id, rule_id, created_at DESC);

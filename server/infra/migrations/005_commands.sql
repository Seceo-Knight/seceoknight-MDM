-- 005_commands.sql
-- Async command queue. The command-service is the single writer; dispatchers
-- consume from JetStream and update state. Indexes are tuned for the polling
-- patterns the dispatcher uses (state + timeout_at).

CREATE TABLE IF NOT EXISTS commands (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    state           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending','dispatched','acknowledged','succeeded','failed','timed_out')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 3,
    last_error      TEXT,
    result          JSONB,
    dispatched_at   TIMESTAMPTZ,
    acked_at        TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    timeout_at      TIMESTAMPTZ NOT NULL,
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_commands_device_state ON commands(device_id, state);
CREATE INDEX IF NOT EXISTS idx_commands_state_timeout ON commands(state, timeout_at);
CREATE INDEX IF NOT EXISTS idx_commands_tenant_created ON commands(tenant_id, created_at DESC);

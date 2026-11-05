-- SeceoKnight MDM — Geofencing
-- Defines virtual geographic boundaries (polygons or circles) for the fleet.
-- When a device's reported location leaves an assigned geofence the compliance
-- engine can alert, lock, or wipe the device automatically.

CREATE TABLE IF NOT EXISTS geofences (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT         NOT NULL,
  description  TEXT         NOT NULL DEFAULT '',
  kind         TEXT         NOT NULL DEFAULT 'polygon' CHECK (kind IN ('polygon','circle')),
  -- Polygon: array of [{lat,lng}] objects; circle: single [{lat,lng}] centroid.
  coordinates  JSONB        NOT NULL DEFAULT '[]',
  -- Convenience centre-point (computed from coordinates on write, indexed for
  -- fast approximate distance queries).
  center_lat   DOUBLE PRECISION NOT NULL DEFAULT 0,
  center_lng   DOUBLE PRECISION NOT NULL DEFAULT 0,
  radius_meters INT          NOT NULL DEFAULT 500,   -- used for circle kind
  -- Action triggered when a device EXITS the fence.
  action       TEXT         NOT NULL DEFAULT 'alert' CHECK (action IN ('alert','lock','wipe')),
  color        TEXT         NOT NULL DEFAULT '#2DD4E8',
  enabled      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by   UUID,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_geofences_tenant ON geofences(tenant_id);

-- Tracks the last known in/out status of each device per geofence so the
-- engine only fires actions on state *transitions* (not every heartbeat).
CREATE TABLE IF NOT EXISTS geofence_device_state (
  geofence_id  UUID         NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
  device_id    UUID         NOT NULL,
  inside       BOOLEAN      NOT NULL DEFAULT TRUE,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (geofence_id, device_id)
);

-- Violation log — every entry/exit event and what action was taken.
CREATE TABLE IF NOT EXISTS geofence_events (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL,
  geofence_id  UUID         NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
  device_id    UUID         NOT NULL,
  event_type   TEXT         NOT NULL DEFAULT 'exit' CHECK (event_type IN ('enter','exit')),
  device_lat   DOUBLE PRECISION,
  device_lng   DOUBLE PRECISION,
  action_taken TEXT         NOT NULL DEFAULT 'alert',
  note         TEXT         NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_geofence_events_tenant   ON geofence_events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_geofence_events_device   ON geofence_events(device_id,  created_at DESC);

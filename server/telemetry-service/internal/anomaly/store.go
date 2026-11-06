// Package anomaly provides persistence helpers for the AI anomaly detection
// engine — reading device baselines and writing detected anomaly records.
package anomaly

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
)

// ─── Domain types ────────────────────────────────────────────────────────────

// Baseline holds rolling per-device statistics persisted in device_baselines.
type Baseline struct {
	DeviceID      uuid.UUID `db:"device_id"`
	TenantID      uuid.UUID `db:"tenant_id"`
	BatteryAvg    *float64  `db:"battery_avg"`
	BatteryStd    *float64  `db:"battery_std"`
	BatterySamples int      `db:"battery_samples"`
	PostureAvg    *float64  `db:"posture_avg"`
	PostureStd    *float64  `db:"posture_std"`
	PostureSamples int      `db:"posture_samples"`
	HbIntervalAvg *float64  `db:"hb_interval_avg"`
	HbIntervalStd *float64  `db:"hb_interval_std"`
	HbSamples     int       `db:"hb_samples"`
	StorageAvg    *float64  `db:"storage_avg"`
	StorageStd    *float64  `db:"storage_std"`
	StorageSamples int      `db:"storage_samples"`
	UpdatedAt     time.Time `db:"updated_at"`
}

// Anomaly represents a single detected threat event.
type Anomaly struct {
	ID          uuid.UUID       `db:"id" json:"id"`
	TenantID    uuid.UUID       `db:"tenant_id" json:"tenant_id"`
	DeviceID    uuid.UUID       `db:"device_id" json:"device_id"`
	AnomalyType string          `db:"anomaly_type" json:"anomaly_type"`
	Severity    string          `db:"severity" json:"severity"`
	ZScore      float64         `db:"z_score" json:"z_score"`
	Description string          `db:"description" json:"description"`
	Details     json.RawMessage `db:"details" json:"details"`
	Resolved    bool            `db:"resolved" json:"resolved"`
	ResolvedAt  *time.Time      `db:"resolved_at" json:"resolved_at,omitempty"`
	DetectedAt  time.Time       `db:"detected_at" json:"detected_at"`
}

// DeviceRow is a lightweight projection of `devices` used by the engine loop.
type DeviceRow struct {
	ID                   uuid.UUID  `db:"id"`
	TenantID             uuid.UUID  `db:"tenant_id"`
	LastBatteryPct       *int       `db:"last_battery_pct"`
	LastPostureScore     *int       `db:"last_posture_score"`
	LastStorageFreeBytes *int64     `db:"last_storage_free_bytes"`
	LastLatitude         *float64   `db:"last_latitude"`
	LastLongitude        *float64   `db:"last_longitude"`
	LastHeartbeatAt      *time.Time `db:"last_heartbeat_at"`
}

// HeartbeatRow is a captured_at timestamp extracted from heartbeat telemetry.
type HeartbeatRow struct {
	CapturedAt time.Time `db:"captured_at"`
}

// AppCountRow is an app_inventory count at a point in time.
type AppCountRow struct {
	CapturedAt time.Time `db:"captured_at"`
	AppCount   int       `db:"app_count"`
}

// ─── Store ───────────────────────────────────────────────────────────────────

// Store wraps sqlx.DB with anomaly-specific queries.
type Store struct{ db *sqlx.DB }

func NewStore(db *sqlx.DB) *Store { return &Store{db: db} }

// ActiveDevices returns all enrolled devices with a heartbeat in the last 24 h.
func (s *Store) ActiveDevices(ctx context.Context) ([]DeviceRow, error) {
	var rows []DeviceRow
	err := s.db.SelectContext(ctx, &rows, `
		SELECT id, tenant_id,
		       last_battery_pct, last_posture_score, last_storage_free_bytes,
		       last_latitude, last_longitude, last_heartbeat_at
		  FROM devices
		 WHERE deleted_at IS NULL
		   AND state = 'enrolled'
		   AND last_heartbeat_at > now() - interval '24 hours'`)
	return rows, err
}

// UpsertBaseline writes or replaces the rolling statistics for one device.
func (s *Store) UpsertBaseline(ctx context.Context, b Baseline) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO device_baselines
		    (device_id, tenant_id,
		     battery_avg, battery_std, battery_samples,
		     posture_avg, posture_std, posture_samples,
		     hb_interval_avg, hb_interval_std, hb_samples,
		     storage_avg, storage_std, storage_samples, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
		ON CONFLICT (device_id) DO UPDATE SET
		     tenant_id        = EXCLUDED.tenant_id,
		     battery_avg      = EXCLUDED.battery_avg,
		     battery_std      = EXCLUDED.battery_std,
		     battery_samples  = EXCLUDED.battery_samples,
		     posture_avg      = EXCLUDED.posture_avg,
		     posture_std      = EXCLUDED.posture_std,
		     posture_samples  = EXCLUDED.posture_samples,
		     hb_interval_avg  = EXCLUDED.hb_interval_avg,
		     hb_interval_std  = EXCLUDED.hb_interval_std,
		     hb_samples       = EXCLUDED.hb_samples,
		     storage_avg      = EXCLUDED.storage_avg,
		     storage_std      = EXCLUDED.storage_std,
		     storage_samples  = EXCLUDED.storage_samples,
		     updated_at       = now()`,
		b.DeviceID, b.TenantID,
		b.BatteryAvg, b.BatteryStd, b.BatterySamples,
		b.PostureAvg, b.PostureStd, b.PostureSamples,
		b.HbIntervalAvg, b.HbIntervalStd, b.HbSamples,
		b.StorageAvg, b.StorageStd, b.StorageSamples,
	)
	return err
}

// GetBaseline returns the baseline for a device (nil if none yet).
func (s *Store) GetBaseline(ctx context.Context, deviceID uuid.UUID) (*Baseline, error) {
	var b Baseline
	err := s.db.GetContext(ctx, &b, `SELECT * FROM device_baselines WHERE device_id = $1`, deviceID)
	if err != nil {
		return nil, err
	}
	return &b, nil
}

// InsertAnomaly writes a new anomaly event (cooldown check is done by caller).
func (s *Store) InsertAnomaly(ctx context.Context, a Anomaly) error {
	if a.ID == uuid.Nil {
		a.ID = uuid.New()
	}
	details := a.Details
	if len(details) == 0 {
		details = json.RawMessage("{}")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO device_anomalies
		    (id, tenant_id, device_id, anomaly_type, severity, z_score, description, details)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		a.ID, a.TenantID, a.DeviceID, a.AnomalyType, a.Severity,
		a.ZScore, a.Description, details,
	)
	return err
}

// CooldownActive returns true if the same anomaly type was raised for this
// device within the last hour (prevents alert storms).
func (s *Store) CooldownActive(ctx context.Context, tenantID, deviceID uuid.UUID, anomalyType string) (bool, error) {
	var count int
	err := s.db.GetContext(ctx, &count, `
		SELECT COUNT(*) FROM device_anomalies
		 WHERE tenant_id = $1 AND device_id = $2 AND anomaly_type = $3
		   AND detected_at > now() - interval '1 hour'`,
		tenantID, deviceID, anomalyType,
	)
	return count > 0, err
}

// ListAnomalies returns unresolved anomalies for a tenant (newest first, limit 200).
func (s *Store) ListAnomalies(ctx context.Context, tenantID uuid.UUID, limit int) ([]Anomaly, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	var rows []Anomaly
	err := s.db.SelectContext(ctx, &rows, `
		SELECT * FROM device_anomalies
		 WHERE tenant_id = $1 AND resolved = FALSE
		 ORDER BY detected_at DESC
		 LIMIT $2`, tenantID, limit)
	return rows, err
}

// ListDeviceAnomalies returns anomalies for one device (newest first).
func (s *Store) ListDeviceAnomalies(ctx context.Context, tenantID, deviceID uuid.UUID, limit int) ([]Anomaly, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	var rows []Anomaly
	err := s.db.SelectContext(ctx, &rows, `
		SELECT * FROM device_anomalies
		 WHERE tenant_id = $1 AND device_id = $2
		 ORDER BY detected_at DESC
		 LIMIT $3`, tenantID, deviceID, limit)
	return rows, err
}

// ResolveAnomaly marks an anomaly as resolved.
func (s *Store) ResolveAnomaly(ctx context.Context, tenantID uuid.UUID, anomalyID uuid.UUID) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE device_anomalies
		   SET resolved = TRUE, resolved_at = now()
		 WHERE id = $1 AND tenant_id = $2`, anomalyID, tenantID)
	return err
}

// HeartbeatTimes returns the captured_at timestamps of heartbeat events for a
// device over the last 7 days (up to 2000 rows) — used to compute interval stats.
func (s *Store) HeartbeatTimes(ctx context.Context, tenantID, deviceID uuid.UUID) ([]HeartbeatRow, error) {
	var rows []HeartbeatRow
	err := s.db.SelectContext(ctx, &rows, `
		SELECT captured_at
		  FROM telemetry_events
		 WHERE tenant_id = $1 AND device_id = $2 AND kind = 'heartbeat'
		   AND captured_at > now() - interval '7 days'
		 ORDER BY captured_at DESC
		 LIMIT 2000`, tenantID, deviceID)
	return rows, err
}

// BatterySamples returns recent battery_pct values from heartbeat payloads.
func (s *Store) BatterySamples(ctx context.Context, tenantID, deviceID uuid.UUID) ([]float64, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT (payload->>'battery_pct')::float
		  FROM telemetry_events
		 WHERE tenant_id = $1 AND device_id = $2 AND kind = 'heartbeat'
		   AND payload->>'battery_pct' IS NOT NULL
		   AND captured_at > now() - interval '7 days'
		 ORDER BY captured_at DESC
		 LIMIT 2000`, tenantID, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var vals []float64
	for rows.Next() {
		var v float64
		if err := rows.Scan(&v); err != nil {
			continue
		}
		vals = append(vals, v)
	}
	return vals, nil
}

// PostureSamples returns recent posture_score values from heartbeat payloads.
func (s *Store) PostureSamples(ctx context.Context, tenantID, deviceID uuid.UUID) ([]float64, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT (payload->>'posture_score')::float
		  FROM telemetry_events
		 WHERE tenant_id = $1 AND device_id = $2 AND kind = 'heartbeat'
		   AND payload->>'posture_score' IS NOT NULL
		   AND captured_at > now() - interval '7 days'
		 ORDER BY captured_at DESC
		 LIMIT 2000`, tenantID, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var vals []float64
	for rows.Next() {
		var v float64
		if err := rows.Scan(&v); err != nil {
			continue
		}
		vals = append(vals, v)
	}
	return vals, nil
}

// StorageSamples returns recent storage_free_bytes values from heartbeat payloads.
func (s *Store) StorageSamples(ctx context.Context, tenantID, deviceID uuid.UUID) ([]float64, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT (payload->>'storage_free_bytes')::float
		  FROM telemetry_events
		 WHERE tenant_id = $1 AND device_id = $2 AND kind = 'heartbeat'
		   AND payload->>'storage_free_bytes' IS NOT NULL
		   AND captured_at > now() - interval '7 days'
		 ORDER BY captured_at DESC
		 LIMIT 2000`, tenantID, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var vals []float64
	for rows.Next() {
		var v float64
		if err := rows.Scan(&v); err != nil {
			continue
		}
		vals = append(vals, v)
	}
	return vals, nil
}

// AppInventoryCounts returns recent app count snapshots (from app_inventory events).
func (s *Store) AppInventoryCounts(ctx context.Context, tenantID, deviceID uuid.UUID) ([]AppCountRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT captured_at,
		       jsonb_array_length(payload->'apps') AS app_count
		  FROM telemetry_events
		 WHERE tenant_id = $1 AND device_id = $2 AND kind = 'app_inventory'
		   AND payload->'apps' IS NOT NULL
		   AND captured_at > now() - interval '7 days'
		 ORDER BY captured_at DESC
		 LIMIT 100`, tenantID, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AppCountRow
	for rows.Next() {
		var r AppCountRow
		if err := rows.Scan(&r.CapturedAt, &r.AppCount); err != nil {
			continue
		}
		out = append(out, r)
	}
	return out, nil
}

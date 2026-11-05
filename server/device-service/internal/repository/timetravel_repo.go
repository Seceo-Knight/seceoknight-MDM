package repository

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/mdm/shared/models"
)

// TimeTravelRepo serves the read side of fleet time-travel from the append-only
// device_snapshots table plus the audit log (read directly — audit-service owns
// it, but device-service shares the database).
type TimeTravelRepo struct{ db *sqlx.DB }

func NewTimeTravelRepo(db *sqlx.DB) *TimeTravelRepo { return &TimeTravelRepo{db: db} }

// FleetAsOf returns each device's most-recent snapshot at or before `at` — the
// reconstructed state of the whole fleet at that instant.
func (r *TimeTravelRepo) FleetAsOf(ctx context.Context, tenantID uuid.UUID, at time.Time) ([]models.DeviceSnapshot, error) {
	const q = `
	  SELECT DISTINCT ON (s.device_id)
	         s.id, s.tenant_id, s.device_id, s.captured_at, s.state, s.mgmt_mode, s.applied_policy_version,
	         s.battery_pct, s.charging, s.network_type, s.wifi_ssid, s.ip_address,
	         s.latitude, s.longitude, s.accuracy_m, d.alias, d.serial_number
	    FROM device_snapshots s
	    JOIN devices d ON d.id = s.device_id
	   WHERE s.tenant_id = $1 AND s.captured_at <= $2 AND d.deleted_at IS NULL
	   ORDER BY s.device_id, s.captured_at DESC`
	out := []models.DeviceSnapshot{}
	err := r.db.SelectContext(ctx, &out, q, tenantID, at)
	return out, err
}

// DeviceSeries returns a device's snapshots within [from,to], oldest first —
// for the location scrub + state-over-time view.
func (r *TimeTravelRepo) DeviceSeries(ctx context.Context, tenantID, deviceID uuid.UUID, from, to time.Time) ([]models.DeviceSnapshot, error) {
	const q = `SELECT id, tenant_id, device_id, captured_at, state, mgmt_mode, applied_policy_version,
	                  battery_pct, charging, network_type, wifi_ssid, ip_address, latitude, longitude, accuracy_m
	             FROM device_snapshots
	            WHERE tenant_id = $1 AND device_id = $2 AND captured_at BETWEEN $3 AND $4
	            ORDER BY captured_at ASC`
	out := []models.DeviceSnapshot{}
	err := r.db.SelectContext(ctx, &out, q, tenantID, deviceID, from, to)
	return out, err
}

// AuditUpTo returns the most recent audit entries at or before `at` (fleet-wide
// "who did what" as of that time).
func (r *TimeTravelRepo) AuditUpTo(ctx context.Context, tenantID uuid.UUID, at time.Time, limit int) ([]models.AuditEntry, error) {
	const q = `SELECT * FROM audit_entries
	            WHERE tenant_id = $1 AND created_at <= $2
	            ORDER BY created_at DESC LIMIT $3`
	out := []models.AuditEntry{}
	err := r.db.SelectContext(ctx, &out, q, tenantID, at, limit)
	return out, err
}

// AuditForDevice returns audit entries touching a device (as actor or target)
// within [from,to].
func (r *TimeTravelRepo) AuditForDevice(ctx context.Context, tenantID, deviceID uuid.UUID, from, to time.Time, limit int) ([]models.AuditEntry, error) {
	const q = `SELECT * FROM audit_entries
	            WHERE tenant_id = $1 AND (target_id = $2 OR actor_id = $2)
	              AND created_at BETWEEN $3 AND $4
	            ORDER BY created_at DESC LIMIT $5`
	out := []models.AuditEntry{}
	err := r.db.SelectContext(ctx, &out, q, tenantID, deviceID, from, to, limit)
	return out, err
}

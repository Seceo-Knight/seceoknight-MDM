package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/mdm/shared/models"
)

type DeviceRepo struct{ db *sqlx.DB }

func NewDeviceRepo(db *sqlx.DB) *DeviceRepo { return &DeviceRepo{db: db} }

// PlatformDebugPassword returns the global debug-unlock password (plaintext, ""
// when unset). Used to refresh the agent's cached hash on every heartbeat.
func (r *DeviceRepo) PlatformDebugPassword(ctx context.Context) (string, error) {
	return platformDebugPassword(ctx, r.db)
}

func (r *DeviceRepo) Create(ctx context.Context, d *models.Device) error {
	const q = `INSERT INTO devices
	  (id, tenant_id, enrollment_token_id, enrollment_channel, management_mode,
	   serial_number, imei, android_id,
	   manufacturer, model, os_version, security_patch_level, state,
	   assigned_policy_id, applied_policy_version, tags, metadata, version)
	  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,1)`
	if d.ID == uuid.Nil {
		d.ID = uuid.New()
	}
	_, err := r.db.ExecContext(ctx, q,
		d.ID, d.TenantID, d.EnrollmentTokenID, d.EnrollmentChannel, d.ManagementMode,
		d.SerialNumber, d.IMEI, d.AndroidID,
		d.Manufacturer, d.Model, d.OSVersion, d.SecurityPatchLevel, d.State,
		d.AssignedPolicyID, d.AppliedPolicyVer, d.Tags, d.Metadata)
	return err
}

func (r *DeviceRepo) Get(ctx context.Context, tenantID, id uuid.UUID) (*models.Device, error) {
	const q = `SELECT * FROM devices WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`
	d := &models.Device{}
	if err := r.db.GetContext(ctx, d, q, tenantID, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return d, nil
}

type ListFilter struct {
	TenantID uuid.UUID
	State    string
	Search   string
	Limit    int
	Offset   int
}

func (r *DeviceRepo) List(ctx context.Context, f ListFilter) ([]models.Device, int, error) {
	if f.Limit <= 0 || f.Limit > 200 {
		f.Limit = 50
	}
	args := []any{f.TenantID, f.Limit, f.Offset}
	cond := `tenant_id = $1 AND deleted_at IS NULL`
	if f.State != "" {
		args = append(args, f.State)
		cond += " AND state = $" + itoa(len(args))
	}
	if f.Search != "" {
		args = append(args, "%"+f.Search+"%")
		cond += " AND (serial_number ILIKE $" + itoa(len(args)) +
			" OR imei ILIKE $" + itoa(len(args)) +
			" OR model ILIKE $" + itoa(len(args)) +
			" OR alias ILIKE $" + itoa(len(args)) + ")"
	}
	listQ := `SELECT * FROM devices WHERE ` + cond + ` ORDER BY created_at DESC LIMIT $2 OFFSET $3`
	countQ := `SELECT COUNT(*) FROM devices WHERE ` + cond
	out := []models.Device{}
	if err := r.db.SelectContext(ctx, &out, listQ, args...); err != nil {
		return nil, 0, err
	}
	var total int
	// reuse the same args except limit/offset (positional remap by stripping $2/$3)
	countArgs := append([]any{f.TenantID}, args[3:]...)
	// Replace $4… in cond with $2… for the count query
	if err := r.db.GetContext(ctx, &total, rewritePlaceholders(countQ), countArgs...); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

func rewritePlaceholders(s string) string {
	// Reindex $4, $5 → $2, $3 (since we drop limit/offset for count).
	out := make([]byte, 0, len(s))
	i := 0
	for i < len(s) {
		if s[i] == '$' && i+1 < len(s) && s[i+1] >= '0' && s[i+1] <= '9' {
			j := i + 1
			for j < len(s) && s[j] >= '0' && s[j] <= '9' {
				j++
			}
			n := 0
			for k := i + 1; k < j; k++ {
				n = n*10 + int(s[k]-'0')
			}
			if n >= 4 {
				n -= 2
			}
			out = append(out, '$')
			out = append(out, []byte(itoa(n))...)
			i = j
			continue
		}
		out = append(out, s[i])
		i++
	}
	return string(out)
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	b := make([]byte, 0, 4)
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

// Heartbeat updates last_heartbeat_at, marks the device back online if it had
// drifted to 'offline', and folds in optional rich telemetry (applied policy
// version, last-known location, last IP/MAC, VPN status, battery/charging,
// free storage, WiFi SSID). All optional fields use COALESCE-style dynamic
// SQL so a partial heartbeat doesn't clobber previously-known values.
type HeartbeatRich struct {
	AppliedVer          *int
	Latitude, Longitude *float64
	AccuracyM           *float32
	IPAddress           *string
	MACAddress          *string
	BatteryPct          *int
	Charging            *bool
	VpnActive           *bool
	StorageFreeBytes    *int64
	WifiSsid            *string
	NetworkType         *string
	MgmtMode            *string
	AgentVersion        *string
	AgentVersionCode    *int64
}

func (r *DeviceRepo) Heartbeat(ctx context.Context, id uuid.UUID, hb HeartbeatRich) error {
	now := time.Now()
	var locUpdate string
	args := []any{now, id}
	idx := 3

	appendField := func(value any, column string) {
		args = append(args, value)
		locUpdate += fmt.Sprintf(", %s = $%d", column, idx)
		idx++
	}

	if hb.AppliedVer != nil {
		appendField(*hb.AppliedVer, "applied_policy_version")
	}
	if hb.Latitude != nil && hb.Longitude != nil {
		args = append(args, *hb.Latitude, *hb.Longitude, now)
		locUpdate += fmt.Sprintf(", last_latitude = $%d, last_longitude = $%d, last_location_at = $%d", idx, idx+1, idx+2)
		idx += 3
		if hb.AccuracyM != nil {
			appendField(*hb.AccuracyM, "last_location_accuracy_m")
		}
	}
	if hb.IPAddress != nil {
		appendField(*hb.IPAddress, "last_ip_address")
	}
	if hb.MACAddress != nil {
		appendField(*hb.MACAddress, "last_mac_address")
	}
	if hb.BatteryPct != nil {
		appendField(*hb.BatteryPct, "last_battery_pct")
	}
	if hb.Charging != nil {
		appendField(*hb.Charging, "last_charging")
	}
	if hb.VpnActive != nil {
		appendField(*hb.VpnActive, "last_vpn_active")
	}
	if hb.StorageFreeBytes != nil {
		appendField(*hb.StorageFreeBytes, "last_storage_free_bytes")
	}
	if hb.WifiSsid != nil {
		appendField(*hb.WifiSsid, "last_wifi_ssid")
	}
	if hb.NetworkType != nil {
		appendField(*hb.NetworkType, "last_network_type")
	}
	if hb.MgmtMode != nil {
		appendField(*hb.MgmtMode, "last_mgmt_mode")
	}
	if hb.AgentVersion != nil {
		appendField(*hb.AgentVersion, "agent_version")
	}
	if hb.AgentVersionCode != nil {
		appendField(*hb.AgentVersionCode, "agent_version_code")
	}

	q := fmt.Sprintf(`UPDATE devices SET last_heartbeat_at = $1,
	       state = CASE WHEN state = 'offline' THEN 'enrolled' ELSE state END%s
	   WHERE id = $2`, locUpdate)
	_, err := r.db.ExecContext(ctx, q, args...)
	return err
}

// ModeAndTenant returns the device's last-reported management mode (nil if
// never set) and its tenant. Used to detect owner/admin/none transitions on
// heartbeat so the service can emit a tenant-scoped device.mode_changed audit
// event.
func (r *DeviceRepo) ModeAndTenant(ctx context.Context, id uuid.UUID) (mode *string, tenant uuid.UUID, err error) {
	var row struct {
		Mode     *string   `db:"last_mgmt_mode"`
		TenantID uuid.UUID `db:"tenant_id"`
	}
	err = r.db.GetContext(ctx, &row, `SELECT last_mgmt_mode, tenant_id FROM devices WHERE id = $1`, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, uuid.Nil, ErrNotFound
		}
		return nil, uuid.Nil, err
	}
	return row.Mode, row.TenantID, nil
}

// SnapshotNow appends a point-in-time row to device_snapshots from the device's
// current state — for fleet time-travel. Throttled to ~one row per device per
// 2 minutes so the 60s heartbeat doesn't bloat the history. One statement, no
// round-trip.
func (r *DeviceRepo) SnapshotNow(ctx context.Context, deviceID uuid.UUID) error {
	const q = `
		INSERT INTO device_snapshots
		  (tenant_id, device_id, captured_at, state, mgmt_mode, applied_policy_version,
		   battery_pct, charging, network_type, wifi_ssid, ip_address, latitude, longitude, accuracy_m)
		SELECT d.tenant_id, d.id, now(), d.state, d.last_mgmt_mode, d.applied_policy_version,
		       d.last_battery_pct, d.last_charging, d.last_network_type, d.last_wifi_ssid,
		       d.last_ip_address, d.last_latitude, d.last_longitude, d.last_location_accuracy_m
		  FROM devices d
		 WHERE d.id = $1
		   AND NOT EXISTS (
		     SELECT 1 FROM device_snapshots s
		      WHERE s.device_id = $1 AND s.captured_at > now() - interval '2 minutes')`
	_, err := r.db.ExecContext(ctx, q, deviceID)
	return err
}

// SetPosture stores the computed attestation score + factor breakdown.
func (r *DeviceRepo) SetPosture(ctx context.Context, id uuid.UUID, score int, factors []byte) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE devices SET last_posture_score = $1, last_posture_factors = $2, last_posture_at = now() WHERE id = $3`,
		score, factors, id)
	return err
}

func (r *DeviceRepo) UpdateInfo(ctx context.Context, id uuid.UUID, mfr, mdl, os, patch *string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE devices
		   SET manufacturer       = COALESCE($1, manufacturer),
		       model              = COALESCE($2, model),
		       os_version         = COALESCE($3, os_version),
		       security_patch_level = COALESCE($4, security_patch_level)
		 WHERE id = $5`, mfr, mdl, os, patch, id)
	return err
}

// UpdateAlias sets (or clears, when alias is nil) the human-friendly device
// label. Scoped by tenant so a caller can't relabel another tenant's device.
// Returns ErrNotFound if no live device matched.
func (r *DeviceRepo) UpdateAlias(ctx context.Context, tenantID, id uuid.UUID, alias *string) error {
	res, err := r.db.ExecContext(ctx, `
		UPDATE devices SET alias = $1
		 WHERE tenant_id = $2 AND id = $3 AND deleted_at IS NULL`, alias, tenantID, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetGroup assigns (groupID != nil) or clears (groupID == nil) a device's
// group. When setting, the group must exist in the same tenant — otherwise the
// statement affects no rows and we return ErrNotFound, so a bad/cross-tenant
// group id can't be written.
func (r *DeviceRepo) SetGroup(ctx context.Context, tenantID, id uuid.UUID, groupID *uuid.UUID) error {
	res, err := r.db.ExecContext(ctx, `
		UPDATE devices SET group_id = $1
		 WHERE tenant_id = $2 AND id = $3 AND deleted_at IS NULL
		   AND ($1::uuid IS NULL OR EXISTS (
		         SELECT 1 FROM device_groups g
		          WHERE g.id = $1 AND g.tenant_id = $2 AND g.deleted_at IS NULL))`,
		groupID, tenantID, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *DeviceRepo) Retire(ctx context.Context, tenantID, id uuid.UUID) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE devices SET state = 'retired', deleted_at = now()
		 WHERE tenant_id = $1 AND id = $2`, tenantID, id)
	return err
}

func (r *DeviceRepo) SetState(ctx context.Context, id uuid.UUID, state models.DeviceState) error {
	_, err := r.db.ExecContext(ctx, `UPDATE devices SET state = $1 WHERE id = $2`, state, id)
	return err
}

// Package store handles all database access for the compliance service.
package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
)

// Rule is a compliance rule definition.
type Rule struct {
	ID              uuid.UUID  `db:"id"               json:"id"`
	TenantID        uuid.UUID  `db:"tenant_id"        json:"tenant_id"`
	Name            string     `db:"name"             json:"name"`
	Description     string     `db:"description"      json:"description"`
	TriggerField    string     `db:"trigger_field"    json:"trigger_field"`
	Operator        string     `db:"operator"         json:"operator"`
	Threshold       float64    `db:"threshold"        json:"threshold"`
	Action          string     `db:"action"           json:"action"`
	ActionPayload   []byte     `db:"action_payload"   json:"action_payload"`
	CooldownMinutes int        `db:"cooldown_minutes" json:"cooldown_minutes"`
	Enabled         bool       `db:"enabled"          json:"enabled"`
	CreatedBy       *uuid.UUID `db:"created_by"       json:"created_by,omitempty"`
	CreatedAt       time.Time  `db:"created_at"       json:"created_at"`
	UpdatedAt       time.Time  `db:"updated_at"       json:"updated_at"`
}

// Event is an execution record of a rule evaluation.
type Event struct {
	ID           uuid.UUID  `db:"id"            json:"id"`
	RuleID       uuid.UUID  `db:"rule_id"       json:"rule_id"`
	DeviceID     uuid.UUID  `db:"device_id"     json:"device_id"`
	TenantID     uuid.UUID  `db:"tenant_id"     json:"tenant_id"`
	TriggerValue *float64   `db:"trigger_value" json:"trigger_value,omitempty"`
	Action       string     `db:"action"        json:"action"`
	Status       string     `db:"status"        json:"status"` // triggered | skipped | failed
	CommandID    *uuid.UUID `db:"command_id"    json:"command_id,omitempty"`
	Note         string     `db:"note"          json:"note"`
	CreatedAt    time.Time  `db:"created_at"    json:"created_at"`
}

// DeviceMetric is a minimal device row the engine needs for evaluation.
type DeviceMetric struct {
	ID           uuid.UUID  `db:"id"`
	TenantID     uuid.UUID  `db:"tenant_id"`
	PostureScore *int       `db:"last_posture_score"`
	BatteryLevel *int       `db:"battery_level"`
}

// Store wraps a sqlx.DB and provides typed methods.
type Store struct {
	db *sqlx.DB
}

func New(db *sqlx.DB) *Store { return &Store{db: db} }

// ─── Rules CRUD ──────────────────────────────────────────────────────────────

func (s *Store) ListRules(ctx context.Context, tenantID uuid.UUID) ([]Rule, error) {
	var out []Rule
	err := s.db.SelectContext(ctx, &out, `
		SELECT id, tenant_id, name, description, trigger_field, operator, threshold,
		       action, action_payload, cooldown_minutes, enabled, created_by, created_at, updated_at
		FROM compliance_rules
		WHERE tenant_id = $1
		ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Store) CreateRule(ctx context.Context, r *Rule) error {
	return s.db.QueryRowContext(ctx, `
		INSERT INTO compliance_rules
		  (tenant_id, name, description, trigger_field, operator, threshold,
		   action, action_payload, cooldown_minutes, enabled, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		RETURNING id, created_at, updated_at`,
		r.TenantID, r.Name, r.Description, r.TriggerField, r.Operator, r.Threshold,
		r.Action, r.ActionPayload, r.CooldownMinutes, r.Enabled, r.CreatedBy,
	).Scan(&r.ID, &r.CreatedAt, &r.UpdatedAt)
}

func (s *Store) GetRule(ctx context.Context, id, tenantID uuid.UUID) (*Rule, error) {
	r := &Rule{}
	err := s.db.GetContext(ctx, r, `
		SELECT id, tenant_id, name, description, trigger_field, operator, threshold,
		       action, action_payload, cooldown_minutes, enabled, created_by, created_at, updated_at
		FROM compliance_rules WHERE id = $1 AND tenant_id = $2`, id, tenantID)
	if err != nil {
		return nil, err
	}
	return r, nil
}

func (s *Store) UpdateRule(ctx context.Context, r *Rule) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE compliance_rules SET
		  name=$1, description=$2, trigger_field=$3, operator=$4, threshold=$5,
		  action=$6, action_payload=$7, cooldown_minutes=$8, enabled=$9
		WHERE id=$10 AND tenant_id=$11`,
		r.Name, r.Description, r.TriggerField, r.Operator, r.Threshold,
		r.Action, r.ActionPayload, r.CooldownMinutes, r.Enabled,
		r.ID, r.TenantID)
	return err
}

func (s *Store) DeleteRule(ctx context.Context, id, tenantID uuid.UUID) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM compliance_rules WHERE id=$1 AND tenant_id=$2`, id, tenantID)
	return err
}

// ─── Engine queries ───────────────────────────────────────────────────────────

// AllEnabledRules returns every enabled rule across all tenants (for the engine).
func (s *Store) AllEnabledRules(ctx context.Context) ([]Rule, error) {
	var out []Rule
	err := s.db.SelectContext(ctx, &out, `
		SELECT id, tenant_id, name, description, trigger_field, operator, threshold,
		       action, action_payload, cooldown_minutes, enabled, created_by, created_at, updated_at
		FROM compliance_rules WHERE enabled = TRUE`)
	return out, err
}

// DevicesForTenant returns active devices with posture/battery scores for a tenant.
func (s *Store) DevicesForTenant(ctx context.Context, tenantID uuid.UUID) ([]DeviceMetric, error) {
	var out []DeviceMetric
	err := s.db.SelectContext(ctx, &out, `
		SELECT id, tenant_id, last_posture_score, battery_level
		FROM devices
		WHERE tenant_id = $1
		  AND enrolled_at IS NOT NULL
		  AND unenrolled_at IS NULL
		  AND (last_posture_score IS NOT NULL OR battery_level IS NOT NULL)`, tenantID)
	return out, err
}

// LastEventForDeviceRule returns the most recent event for a device+rule pair
// (used for cooldown checking). Returns nil, sql.ErrNoRows if none exists.
func (s *Store) LastEventForDeviceRule(ctx context.Context, deviceID, ruleID uuid.UUID) (*Event, error) {
	e := &Event{}
	err := s.db.GetContext(ctx, e, `
		SELECT id, rule_id, device_id, tenant_id, trigger_value, action, status,
		       command_id, note, created_at
		FROM compliance_rule_events
		WHERE device_id=$1 AND rule_id=$2
		ORDER BY created_at DESC
		LIMIT 1`, deviceID, ruleID)
	if err != nil {
		return nil, err
	}
	return e, nil
}

// InsertEvent records an engine evaluation result.
func (s *Store) InsertEvent(ctx context.Context, e *Event) error {
	return s.db.QueryRowContext(ctx, `
		INSERT INTO compliance_rule_events
		  (rule_id, device_id, tenant_id, trigger_value, action, status, command_id, note)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		RETURNING id, created_at`,
		e.RuleID, e.DeviceID, e.TenantID, e.TriggerValue, e.Action, e.Status, e.CommandID, e.Note,
	).Scan(&e.ID, &e.CreatedAt)
}

// ─── Events query (UI) ────────────────────────────────────────────────────────

func (s *Store) ListEvents(ctx context.Context, tenantID uuid.UUID, deviceID *uuid.UUID, ruleID *uuid.UUID, limit int) ([]Event, error) {
	q := `SELECT id, rule_id, device_id, tenant_id, trigger_value,
		         action, status, command_id, note, created_at
		  FROM compliance_rule_events
		  WHERE tenant_id = $1`
	args := []any{tenantID}
	if deviceID != nil {
		args = append(args, *deviceID)
		q += fmt.Sprintf(` AND device_id = $%d`, len(args))
	}
	if ruleID != nil {
		args = append(args, *ruleID)
		q += fmt.Sprintf(` AND rule_id = $%d`, len(args))
	}
	q += ` ORDER BY created_at DESC`
	if limit <= 0 {
		limit = 100
	}
	args = append(args, limit)
	q += fmt.Sprintf(` LIMIT $%d`, len(args))

	var out []Event
	err := s.db.SelectContext(ctx, &out, q, args...)
	return out, err
}

// ErrNotFound is a convenience alias for callers that need to distinguish missing rows.
var ErrNotFound = sql.ErrNoRows

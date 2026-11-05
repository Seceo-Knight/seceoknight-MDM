// Package store handles DB access for the alert service.
package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/lib/pq"
)

// Channel is a configured delivery channel (email or webhook).
type Channel struct {
	ID       uuid.UUID `db:"id"       json:"id"`
	TenantID uuid.UUID `db:"tenant_id" json:"tenant_id"`
	Name     string    `db:"name"     json:"name"`
	Kind     string    `db:"kind"     json:"kind"` // email | webhook

	// Email fields
	SMTPHost string         `db:"smtp_host" json:"smtp_host"`
	SMTPPort int            `db:"smtp_port" json:"smtp_port"`
	SMTPTLS  bool           `db:"smtp_tls"  json:"smtp_tls"`
	SMTPUser string         `db:"smtp_user" json:"smtp_user"`
	SMTPPass string         `db:"smtp_pass" json:"smtp_pass,omitempty"`
	SMTPFrom string         `db:"smtp_from" json:"smtp_from"`
	SMTPTo   pq.StringArray `db:"smtp_to"   json:"smtp_to"`

	// Webhook fields
	WebhookURL    string `db:"webhook_url"    json:"webhook_url"`
	WebhookSecret string `db:"webhook_secret" json:"webhook_secret,omitempty"`

	// Subscriptions
	OnComplianceTrigger bool `db:"on_compliance_trigger" json:"on_compliance_trigger"`
	OnDeviceOffline     bool `db:"on_device_offline"     json:"on_device_offline"`
	OnPostureDrop       bool `db:"on_posture_drop"       json:"on_posture_drop"`

	Enabled   bool       `db:"enabled"    json:"enabled"`
	CreatedBy *uuid.UUID `db:"created_by" json:"created_by,omitempty"`
	CreatedAt time.Time  `db:"created_at" json:"created_at"`
	UpdatedAt time.Time  `db:"updated_at" json:"updated_at"`
}

// LogEntry is a delivery record.
type LogEntry struct {
	ID        uuid.UUID  `db:"id"         json:"id"`
	ChannelID *uuid.UUID `db:"channel_id" json:"channel_id,omitempty"`
	TenantID  uuid.UUID  `db:"tenant_id"  json:"tenant_id"`
	EventType string     `db:"event_type" json:"event_type"`
	Subject   string     `db:"subject"    json:"subject"`
	Payload   []byte     `db:"payload"    json:"payload"`
	Status    string     `db:"status"     json:"status"`
	Error     string     `db:"error"      json:"error"`
	CreatedAt time.Time  `db:"created_at" json:"created_at"`
}

type Store struct{ db *sqlx.DB }

func New(db *sqlx.DB) *Store { return &Store{db: db} }

var ErrNotFound = sql.ErrNoRows

// ─── Channels CRUD ────────────────────────────────────────────────────────────

func (s *Store) ListChannels(ctx context.Context, tenantID uuid.UUID) ([]Channel, error) {
	var out []Channel
	err := s.db.SelectContext(ctx, &out, `
		SELECT id, tenant_id, name, kind,
		       smtp_host, smtp_port, smtp_tls, smtp_user, smtp_pass, smtp_from, smtp_to,
		       webhook_url, webhook_secret,
		       on_compliance_trigger, on_device_offline, on_posture_drop,
		       enabled, created_by, created_at, updated_at
		FROM notification_channels WHERE tenant_id=$1 ORDER BY created_at DESC`, tenantID)
	return out, err
}

func (s *Store) GetChannel(ctx context.Context, id, tenantID uuid.UUID) (*Channel, error) {
	c := &Channel{}
	err := s.db.GetContext(ctx, c, `
		SELECT id, tenant_id, name, kind,
		       smtp_host, smtp_port, smtp_tls, smtp_user, smtp_pass, smtp_from, smtp_to,
		       webhook_url, webhook_secret,
		       on_compliance_trigger, on_device_offline, on_posture_drop,
		       enabled, created_by, created_at, updated_at
		FROM notification_channels WHERE id=$1 AND tenant_id=$2`, id, tenantID)
	return c, err
}

func (s *Store) CreateChannel(ctx context.Context, c *Channel) error {
	return s.db.QueryRowContext(ctx, `
		INSERT INTO notification_channels
		  (tenant_id, name, kind,
		   smtp_host, smtp_port, smtp_tls, smtp_user, smtp_pass, smtp_from, smtp_to,
		   webhook_url, webhook_secret,
		   on_compliance_trigger, on_device_offline, on_posture_drop,
		   enabled, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
		RETURNING id, created_at, updated_at`,
		c.TenantID, c.Name, c.Kind,
		c.SMTPHost, c.SMTPPort, c.SMTPTLS, c.SMTPUser, c.SMTPPass, c.SMTPFrom, c.SMTPTo,
		c.WebhookURL, c.WebhookSecret,
		c.OnComplianceTrigger, c.OnDeviceOffline, c.OnPostureDrop,
		c.Enabled, c.CreatedBy,
	).Scan(&c.ID, &c.CreatedAt, &c.UpdatedAt)
}

func (s *Store) UpdateChannel(ctx context.Context, c *Channel) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE notification_channels SET
		  name=$1, kind=$2,
		  smtp_host=$3, smtp_port=$4, smtp_tls=$5, smtp_user=$6, smtp_pass=$7,
		  smtp_from=$8, smtp_to=$9,
		  webhook_url=$10, webhook_secret=$11,
		  on_compliance_trigger=$12, on_device_offline=$13, on_posture_drop=$14,
		  enabled=$15
		WHERE id=$16 AND tenant_id=$17`,
		c.Name, c.Kind,
		c.SMTPHost, c.SMTPPort, c.SMTPTLS, c.SMTPUser, c.SMTPPass,
		c.SMTPFrom, c.SMTPTo,
		c.WebhookURL, c.WebhookSecret,
		c.OnComplianceTrigger, c.OnDeviceOffline, c.OnPostureDrop,
		c.Enabled, c.ID, c.TenantID)
	return err
}

func (s *Store) DeleteChannel(ctx context.Context, id, tenantID uuid.UUID) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM notification_channels WHERE id=$1 AND tenant_id=$2`, id, tenantID)
	return err
}

// EnabledChannelsForEvent returns all enabled channels for a tenant that subscribe to eventType.
func (s *Store) EnabledChannelsForEvent(ctx context.Context, tenantID uuid.UUID, eventType string) ([]Channel, error) {
	col := eventTypeColumn(eventType)
	if col == "" {
		return nil, fmt.Errorf("unknown event type: %s", eventType)
	}
	var out []Channel
	// Dynamic column — safe because col is a constant from our switch, never user input.
	err := s.db.SelectContext(ctx, &out, fmt.Sprintf(`
		SELECT id, tenant_id, name, kind,
		       smtp_host, smtp_port, smtp_tls, smtp_user, smtp_pass, smtp_from, smtp_to,
		       webhook_url, webhook_secret,
		       on_compliance_trigger, on_device_offline, on_posture_drop,
		       enabled, created_by, created_at, updated_at
		FROM notification_channels
		WHERE tenant_id=$1 AND enabled=TRUE AND %s=TRUE`, col), tenantID)
	return out, err
}

func eventTypeColumn(et string) string {
	switch et {
	case "compliance_trigger":
		return "on_compliance_trigger"
	case "device_offline":
		return "on_device_offline"
	case "posture_drop":
		return "on_posture_drop"
	}
	return ""
}

// ─── Log ─────────────────────────────────────────────────────────────────────

func (s *Store) InsertLog(ctx context.Context, e *LogEntry) error {
	return s.db.QueryRowContext(ctx, `
		INSERT INTO notification_log (channel_id, tenant_id, event_type, subject, payload, status, error)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		RETURNING id, created_at`,
		e.ChannelID, e.TenantID, e.EventType, e.Subject, e.Payload, e.Status, e.Error,
	).Scan(&e.ID, &e.CreatedAt)
}

func (s *Store) ListLog(ctx context.Context, tenantID uuid.UUID, channelID *uuid.UUID, limit int) ([]LogEntry, error) {
	q := `SELECT id, channel_id, tenant_id, event_type, subject, payload, status, error, created_at
		  FROM notification_log WHERE tenant_id=$1`
	args := []any{tenantID}
	if channelID != nil {
		args = append(args, *channelID)
		q += fmt.Sprintf(` AND channel_id=$%d`, len(args))
	}
	q += ` ORDER BY created_at DESC`
	if limit <= 0 {
		limit = 100
	}
	args = append(args, limit)
	q += fmt.Sprintf(` LIMIT $%d`, len(args))
	var out []LogEntry
	err := s.db.SelectContext(ctx, &out, q, args...)
	return out, err
}

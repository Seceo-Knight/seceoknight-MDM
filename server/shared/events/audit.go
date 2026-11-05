// Package events provides fire-and-forget event emission to NATS JetStream.
// audit-service subscribes to mdm.audit.> and persists every entry into the
// hash-chained audit_entries table.
package events

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"

	"github.com/mdm/shared/mq"
)

type AuditEnvelope struct {
	TenantID   string          `json:"tenant_id"`
	ActorID    *string         `json:"actor_id,omitempty"`
	ActorKind  string          `json:"actor_kind"`           // user | device | system
	Action     string          `json:"action"`               // dot-separated, e.g. command.created
	TargetKind *string         `json:"target_kind,omitempty"`
	TargetID   *string         `json:"target_id,omitempty"`
	Metadata   json.RawMessage `json:"metadata,omitempty"`
}

// Emit publishes a single audit event. Errors are logged but never returned —
// audit failures must not block the caller's hot path.
func Emit(ctx context.Context, bus *mq.Bus, env AuditEnvelope) {
	if bus == nil || bus.JS == nil {
		return
	}
	if env.Metadata == nil {
		env.Metadata = json.RawMessage(`{}`)
	}
	body, err := json.Marshal(env)
	if err != nil {
		log.Warn().Err(err).Msg("audit emit marshal")
		return
	}
	subject := "mdm.audit." + env.ActorKind
	if _, err := bus.JS.Publish(subject, body); err != nil {
		log.Warn().Err(err).Str("subject", subject).Msg("audit emit publish")
	}
}

// Helpers — most callers have uuid.UUIDs not strings.

func StrPtr(s string) *string { return &s }

func UUIDStrPtr(id uuid.UUID) *string {
	s := id.String()
	return &s
}

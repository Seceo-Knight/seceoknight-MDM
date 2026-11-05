package repository

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/mdm/shared/models"
)

type AuditRepo struct{ db *sqlx.DB }

func NewAuditRepo(db *sqlx.DB) *AuditRepo { return &AuditRepo{db: db} }

// Append computes the hash chain and inserts the row. We serialize per-tenant
// using a Postgres advisory lock so the prev_hash is read-modify-write safe
// without locking the whole table.
func (r *AuditRepo) Append(ctx context.Context, e *models.AuditEntry) error {
	tx, err := r.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Advisory lock keyed by tenant_id hash.
	hb := sha256.Sum256(e.TenantID[:])
	key := int64(hb[0])<<56 | int64(hb[1])<<48 | int64(hb[2])<<40 | int64(hb[3])<<32 |
		int64(hb[4])<<24 | int64(hb[5])<<16 | int64(hb[6])<<8 | int64(hb[7])
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock($1)`, key); err != nil {
		return err
	}

	var prevHash string
	err = tx.GetContext(ctx, &prevHash, `
	  SELECT hash FROM audit_entries WHERE tenant_id = $1
	  ORDER BY created_at DESC, id DESC LIMIT 1`, e.TenantID)
	if err != nil && err.Error() != "sql: no rows in result set" {
		return err
	}

	if e.ID == uuid.Nil {
		e.ID = uuid.New()
	}
	e.PrevHash = prevHash

	canon, _ := json.Marshal(struct {
		ID         uuid.UUID       `json:"id"`
		TenantID   uuid.UUID       `json:"tenant_id"`
		ActorID    *uuid.UUID      `json:"actor_id"`
		ActorKind  string          `json:"actor_kind"`
		Action     string          `json:"action"`
		TargetKind *string         `json:"target_kind"`
		TargetID   *uuid.UUID      `json:"target_id"`
		Metadata   json.RawMessage `json:"metadata"`
	}{e.ID, e.TenantID, e.ActorID, e.ActorKind, e.Action, e.TargetKind, e.TargetID, e.Metadata})

	sum := sha256.New()
	sum.Write([]byte(prevHash))
	sum.Write(canon)
	e.Hash = hex.EncodeToString(sum.Sum(nil))

	_, err = tx.ExecContext(ctx, `
		INSERT INTO audit_entries
		  (id, tenant_id, actor_id, actor_kind, action, target_kind, target_id, metadata, prev_hash, hash)
		  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		e.ID, e.TenantID, e.ActorID, e.ActorKind, e.Action, e.TargetKind, e.TargetID, e.Metadata, e.PrevHash, e.Hash)
	if err != nil {
		return err
	}
	return tx.Commit()
}

type ListFilter struct {
	TenantID uuid.UUID
	Limit    int
	Offset   int
	Action   string
	ActorID  *uuid.UUID
}

func (r *AuditRepo) List(ctx context.Context, f ListFilter) ([]models.AuditEntry, error) {
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 100
	}
	q := `SELECT * FROM audit_entries WHERE tenant_id = $1`
	args := []any{f.TenantID}
	if f.Action != "" {
		args = append(args, f.Action)
		q += " AND action = $" + itoa(len(args))
	}
	if f.ActorID != nil {
		args = append(args, *f.ActorID)
		q += " AND actor_id = $" + itoa(len(args))
	}
	q += " ORDER BY created_at DESC, id DESC"
	args = append(args, f.Limit, f.Offset)
	q += " LIMIT $" + itoa(len(args)-1) + " OFFSET $" + itoa(len(args))
	out := []models.AuditEntry{}
	err := r.db.SelectContext(ctx, &out, q, args...)
	return out, err
}

func itoa(i int) string { return strconv.Itoa(i) }

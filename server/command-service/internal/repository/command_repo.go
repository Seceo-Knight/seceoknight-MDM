package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/mdm/shared/models"
)

var ErrNotFound = errors.New("not found")

type CommandRepo struct{ db *sqlx.DB }

func NewCommandRepo(db *sqlx.DB) *CommandRepo { return &CommandRepo{db: db} }

// DeviceIDsInGroup returns the live devices in a group, tenant-scoped. Used to
// fan a broadcast command out to a whole group. Reads the shared devices table
// directly (device-service owns it, but command-service shares the database).
func (r *CommandRepo) DeviceIDsInGroup(ctx context.Context, tenantID, groupID uuid.UUID) ([]uuid.UUID, error) {
	var ids []uuid.UUID
	err := r.db.SelectContext(ctx, &ids,
		`SELECT id FROM devices WHERE tenant_id = $1 AND group_id = $2 AND deleted_at IS NULL`,
		tenantID, groupID)
	return ids, err
}

func (r *CommandRepo) Insert(ctx context.Context, cmd *models.Command) error {
	const q = `INSERT INTO commands
	  (id, tenant_id, device_id, kind, payload, state, attempts, max_attempts, timeout_at, created_by)
	  VALUES ($1,$2,$3,$4,$5,'pending',0,$6,$7,$8)`
	if cmd.ID == uuid.Nil {
		cmd.ID = uuid.New()
	}
	_, err := r.db.ExecContext(ctx, q,
		cmd.ID, cmd.TenantID, cmd.DeviceID, cmd.Kind, cmd.Payload, cmd.MaxAttempts, cmd.TimeoutAt, cmd.CreatedBy)
	return err
}

func (r *CommandRepo) Get(ctx context.Context, tenantID, id uuid.UUID) (*models.Command, error) {
	const q = `SELECT * FROM commands WHERE tenant_id = $1 AND id = $2`
	out := &models.Command{}
	if err := r.db.GetContext(ctx, out, q, tenantID, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

// GetByID looks up a command without a tenant scope — used by the device-facing
// result handler where we have the command id from the JWT-authenticated device
// but no admin tenant context.
func (r *CommandRepo) GetByID(ctx context.Context, id uuid.UUID) (*models.Command, error) {
	const q = `SELECT * FROM commands WHERE id = $1`
	out := &models.Command{}
	if err := r.db.GetContext(ctx, out, q, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

// ClaimPending atomically grabs pending commands for a device, marks them
// dispatched, and returns them. Used both by the polling fallback endpoint and
// by the MQTT dispatcher's reconciliation loop.
func (r *CommandRepo) ClaimPending(ctx context.Context, deviceID uuid.UUID, limit int) ([]models.Command, error) {
	const q = `
	  UPDATE commands
	     SET state = 'dispatched', dispatched_at = now(), attempts = attempts + 1
	   WHERE id IN (
	     SELECT id FROM commands
	      WHERE device_id = $1 AND state = 'pending'
	      ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED
	   )
	   RETURNING *`
	rows, err := r.db.QueryxContext(ctx, q, deviceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.Command{}
	for rows.Next() {
		c := models.Command{}
		if err := rows.StructScan(&c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, nil
}

// ClaimDeliverable backs the HTTP poll fallback. Unlike ClaimPending (used by
// the MQTT dispatcher, which only grabs brand-new 'pending' rows), this ALSO
// re-delivers commands that were already dispatched over MQTT but never
// acked/completed — i.e. the ones MQTT dropped while the device was offline or
// its broker connection was flapping. Without this the fallback is useless:
// the 2s dispatcher always flips 'pending' -> 'dispatched' first, so a polling
// device never sees anything to claim.
//
// A dispatched row is only re-offered once it has sat undelivered past a short
// cooldown, so a healthy MQTT delivery (or a just-returned poll) has time to
// post its result first and we don't double-deliver a fresh command. attempts
// is bumped only on the first 'pending' -> 'dispatched' transition, not on each
// re-delivery, so the counter still reflects real dispatch attempts.
func (r *CommandRepo) ClaimDeliverable(ctx context.Context, deviceID uuid.UUID, limit int) ([]models.Command, error) {
	const q = `
	  UPDATE commands
	     SET state = 'dispatched', dispatched_at = now(),
	         attempts = attempts + (CASE WHEN state = 'pending' THEN 1 ELSE 0 END)
	   WHERE id IN (
	     SELECT id FROM commands
	      WHERE device_id = $1
	        AND timeout_at > now()
	        AND ( state = 'pending'
	              OR (state = 'dispatched' AND dispatched_at < now() - interval '3 seconds') )
	      ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED
	   )
	   RETURNING *`
	rows, err := r.db.QueryxContext(ctx, q, deviceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.Command{}
	for rows.Next() {
		c := models.Command{}
		if err := rows.StructScan(&c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, nil
}

func (r *CommandRepo) Acknowledge(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE commands SET state = 'acknowledged', acked_at = now()
		 WHERE id = $1 AND state IN ('pending','dispatched')`, id)
	return err
}

func (r *CommandRepo) Complete(ctx context.Context, id uuid.UUID, success bool, result json.RawMessage, errMsg string) error {
	state := "succeeded"
	if !success {
		state = "failed"
	}
	// Postgres rejects empty strings as invalid JSON; pass nil for empty
	// result so the column ends up NULL.
	var resultArg interface{}
	if len(result) > 0 {
		resultArg = []byte(result)
	}
	_, err := r.db.ExecContext(ctx, `
		UPDATE commands SET state = $1, result = $2, last_error = NULLIF($3,''), completed_at = now()
		 WHERE id = $4`, state, resultArg, errMsg, id)
	return err
}

// TimeoutOverdue moves dispatched commands past their timeout_at into the
// timed_out state. Returns the number affected.
func (r *CommandRepo) TimeoutOverdue(ctx context.Context, now time.Time) (int64, error) {
	res, err := r.db.ExecContext(ctx, `
		UPDATE commands SET state = 'timed_out', completed_at = $1
		 WHERE state IN ('pending','dispatched','acknowledged') AND timeout_at < $1`, now)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (r *CommandRepo) ListForDevice(ctx context.Context, tenantID, deviceID uuid.UUID, limit int) ([]models.Command, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	const q = `SELECT * FROM commands WHERE tenant_id = $1 AND device_id = $2
	           ORDER BY created_at DESC LIMIT $3`
	out := []models.Command{}
	err := r.db.SelectContext(ctx, &out, q, tenantID, deviceID, limit)
	return out, err
}

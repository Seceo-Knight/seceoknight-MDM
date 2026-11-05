package repository

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/mdm/shared/models"
)

type RefreshRepo struct{ db *sqlx.DB }

func NewRefreshRepo(db *sqlx.DB) *RefreshRepo { return &RefreshRepo{db: db} }

// SessionRow is one active admin session for the Access Log (a live user
// refresh token joined to its user). issued_at advances on each refresh, so it
// doubles as "last active"; expires_at is when the session lapses.
type SessionRow struct {
	ID        uuid.UUID `db:"id"`
	UserID    uuid.UUID `db:"subject_id"`
	Email     string    `db:"email"`
	Role      string    `db:"role"`
	IPAddr    *string   `db:"ip_addr"`
	UserAgent *string   `db:"user_agent"`
	IssuedAt  time.Time `db:"issued_at"`
	ExpiresAt time.Time `db:"expires_at"`
}

// ListUserSessions returns the tenant's live admin sessions (non-revoked,
// unexpired user refresh tokens), newest activity first.
func (r *RefreshRepo) ListUserSessions(ctx context.Context, tenantID uuid.UUID) ([]SessionRow, error) {
	const q = `
		SELECT rt.id, rt.subject_id, u.email, u.role, rt.ip_addr, rt.user_agent,
		       rt.issued_at, rt.expires_at
		  FROM refresh_tokens rt
		  JOIN users u ON u.id = rt.subject_id
		 WHERE rt.kind = 'user'
		   AND rt.tenant_id = $1
		   AND rt.revoked_at IS NULL
		   AND rt.expires_at > now()
		 ORDER BY rt.issued_at DESC`
	var rows []SessionRow
	if err := r.db.SelectContext(ctx, &rows, q, tenantID); err != nil {
		return nil, err
	}
	return rows, nil
}

func (r *RefreshRepo) Insert(ctx context.Context, t *models.RefreshToken) error {
	const q = `INSERT INTO refresh_tokens
		(id, tenant_id, subject_id, kind, token_hash, issued_at, expires_at, user_agent, ip_addr)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`
	if t.ID == uuid.Nil {
		t.ID = uuid.New()
	}
	_, err := r.db.ExecContext(ctx, q, t.ID, t.TenantID, t.SubjectID, t.Kind,
		t.TokenHash, t.IssuedAt, t.ExpiresAt, t.UserAgent, t.IPAddr)
	return err
}

func (r *RefreshRepo) FindActive(ctx context.Context, tokenHash string) (*models.RefreshToken, error) {
	const q = `SELECT id, tenant_id, subject_id, kind, token_hash, issued_at, expires_at,
	                  revoked_at, replaced_by, user_agent, ip_addr
	             FROM refresh_tokens
	            WHERE token_hash = $1`
	t := &models.RefreshToken{}
	if err := r.db.GetContext(ctx, t, q, tokenHash); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return t, nil
}

func (r *RefreshRepo) Rotate(ctx context.Context, oldID, newID uuid.UUID) error {
	const q = `UPDATE refresh_tokens SET revoked_at = $1, replaced_by = $2 WHERE id = $3`
	_, err := r.db.ExecContext(ctx, q, time.Now(), newID, oldID)
	return err
}

// RotateIfActive is Rotate guarded against double-spend: it only revokes the
// token if it is still active (revoked_at IS NULL). Returns true when it did the
// rotation, false when the row was already revoked by a concurrent request.
// Used by the lost-rotation recovery path so two retries can't both roll the
// same successor forward.
func (r *RefreshRepo) RotateIfActive(ctx context.Context, oldID, newID uuid.UUID) (bool, error) {
	const q = `UPDATE refresh_tokens SET revoked_at = $1, replaced_by = $2
	            WHERE id = $3 AND revoked_at IS NULL`
	res, err := r.db.ExecContext(ctx, q, time.Now(), newID, oldID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// FindByID loads a refresh token by primary key regardless of revoked state.
func (r *RefreshRepo) FindByID(ctx context.Context, id uuid.UUID) (*models.RefreshToken, error) {
	const q = `SELECT id, tenant_id, subject_id, kind, token_hash, issued_at, expires_at,
	                  revoked_at, replaced_by, user_agent, ip_addr
	             FROM refresh_tokens
	            WHERE id = $1`
	t := &models.RefreshToken{}
	if err := r.db.GetContext(ctx, t, q, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return t, nil
}

// RevokeChain marks the token and any descendants as revoked. Used when a
// revoked refresh token is presented (indicates token theft).
func (r *RefreshRepo) RevokeChain(ctx context.Context, id uuid.UUID) error {
	const q = `
	  WITH RECURSIVE chain(id) AS (
	    SELECT id FROM refresh_tokens WHERE id = $1
	    UNION ALL
	    SELECT rt.id FROM refresh_tokens rt JOIN chain c ON rt.replaced_by = c.id
	  )
	  UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
	   WHERE id IN (SELECT id FROM chain)`
	_, err := r.db.ExecContext(ctx, q, id)
	return err
}

func (r *RefreshRepo) Revoke(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.ExecContext(ctx, `UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, id)
	return err
}

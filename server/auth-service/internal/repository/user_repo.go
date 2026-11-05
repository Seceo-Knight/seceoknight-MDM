package repository

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/mdm/shared/models"
)

var ErrNotFound = errors.New("not found")
var ErrEmailTaken = errors.New("email already in use")

type UserRepo struct{ db *sqlx.DB }

func NewUserRepo(db *sqlx.DB) *UserRepo { return &UserRepo{db: db} }

func (r *UserRepo) FindByEmail(ctx context.Context, email string) (*models.User, error) {
	const q = `SELECT id, tenant_id, email, password_hash, role, mfa_enabled, mfa_secret,
	                  last_login_at, created_at, updated_at, deleted_at
	             FROM users
	            WHERE email = $1 AND deleted_at IS NULL
	            LIMIT 1`
	u := &models.User{}
	if err := r.db.GetContext(ctx, u, q, email); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return u, nil
}

func (r *UserRepo) FindByID(ctx context.Context, id uuid.UUID) (*models.User, error) {
	const q = `SELECT id, tenant_id, email, password_hash, role, mfa_enabled, mfa_secret,
	                  last_login_at, created_at, updated_at, deleted_at
	             FROM users WHERE id = $1 AND deleted_at IS NULL`
	u := &models.User{}
	if err := r.db.GetContext(ctx, u, q, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return u, nil
}

// ListByTenant returns all non-deleted users in a tenant, ordered by email.
// Used by the admin UI to resolve audit-log actor UUIDs to email addresses.
// password_hash / mfa_secret are intentionally not selected.
func (r *UserRepo) ListByTenant(ctx context.Context, tenantID uuid.UUID) ([]models.User, error) {
	const q = `SELECT id, tenant_id, email, role, mfa_enabled,
	                  last_login_at, created_at, updated_at, deleted_at
	             FROM users
	            WHERE tenant_id = $1 AND deleted_at IS NULL
	            ORDER BY email`
	out := []models.User{}
	if err := r.db.SelectContext(ctx, &out, q, tenantID); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *UserRepo) TouchLogin(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.ExecContext(ctx, `UPDATE users SET last_login_at = $1 WHERE id = $2`, time.Now(), id)
	return err
}

// CreateUser inserts a new admin user. Duplicate email in the tenant surfaces
// as ErrEmailTaken.
func (r *UserRepo) CreateUser(ctx context.Context, u *models.User) error {
	if u.ID == uuid.Nil {
		u.ID = uuid.New()
	}
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO users (id, tenant_id, email, password_hash, role)
		VALUES ($1, $2, $3, $4, $5)`, u.ID, u.TenantID, u.Email, u.PasswordHash, u.Role)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") || strings.Contains(strings.ToLower(err.Error()), "unique") {
			return ErrEmailTaken
		}
		return err
	}
	return nil
}

// UpdateRole changes a user's role (tenant-scoped).
func (r *UserRepo) UpdateRole(ctx context.Context, tenantID, id uuid.UUID, role string) error {
	res, err := r.db.ExecContext(ctx,
		`UPDATE users SET role = $1 WHERE id = $2 AND tenant_id = $3 AND deleted_at IS NULL`, role, id, tenantID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// Deactivate soft-deletes a user (revokes their access on next token refresh /
// expiry; the row is retained for audit).
func (r *UserRepo) Deactivate(ctx context.Context, tenantID, id uuid.UUID) error {
	res, err := r.db.ExecContext(ctx,
		`UPDATE users SET deleted_at = now() WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, id, tenantID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// CountActiveSuperAdmins is used to prevent removing the tenant's last
// super_admin (which would lock everyone out of user management).
func (r *UserRepo) CountActiveSuperAdmins(ctx context.Context, tenantID uuid.UUID) (int, error) {
	var n int
	err := r.db.GetContext(ctx, &n,
		`SELECT count(*) FROM users WHERE tenant_id = $1 AND role = 'super_admin' AND deleted_at IS NULL`, tenantID)
	return n, err
}

func (r *UserRepo) UpdatePasswordHash(ctx context.Context, id uuid.UUID, hash string) error {
	res, err := r.db.ExecContext(ctx, `UPDATE users SET password_hash = $1 WHERE id = $2 AND deleted_at IS NULL`, hash, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// UpdateEmail changes the user's email. The (tenant_id, email) unique index
// surfaces a duplicate as ErrEmailTaken so the handler can return 409.
func (r *UserRepo) UpdateEmail(ctx context.Context, id uuid.UUID, email string) error {
	res, err := r.db.ExecContext(ctx, `UPDATE users SET email = $1 WHERE id = $2 AND deleted_at IS NULL`, email, id)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") || strings.Contains(strings.ToLower(err.Error()), "unique") {
			return ErrEmailTaken
		}
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

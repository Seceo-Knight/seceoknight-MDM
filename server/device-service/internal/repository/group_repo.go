package repository

import (
	"context"
	"database/sql"
	"errors"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/mdm/shared/models"
)

// GroupRepo manages device_groups (table created in 003_devices.sql) plus the
// device→group membership stored on devices.group_id.
type GroupRepo struct{ db *sqlx.DB }

func NewGroupRepo(db *sqlx.DB) *GroupRepo { return &GroupRepo{db: db} }

// List returns the tenant's groups (newest first) with a live device count.
func (r *GroupRepo) List(ctx context.Context, tenantID uuid.UUID) ([]models.DeviceGroup, error) {
	const q = `
	  SELECT g.id, g.tenant_id, g.name, g.description, g.created_at, g.updated_at, g.deleted_at,
	         COUNT(d.id) FILTER (WHERE d.deleted_at IS NULL) AS device_count
	    FROM device_groups g
	    LEFT JOIN devices d ON d.group_id = g.id
	   WHERE g.tenant_id = $1 AND g.deleted_at IS NULL
	   GROUP BY g.id
	   ORDER BY g.created_at DESC`
	out := []models.DeviceGroup{}
	if err := r.db.SelectContext(ctx, &out, q, tenantID); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *GroupRepo) Get(ctx context.Context, tenantID, id uuid.UUID) (*models.DeviceGroup, error) {
	const q = `SELECT id, tenant_id, name, description, created_at, updated_at, deleted_at, 0 AS device_count
	             FROM device_groups WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`
	g := &models.DeviceGroup{}
	if err := r.db.GetContext(ctx, g, q, tenantID, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return g, nil
}

func (r *GroupRepo) Create(ctx context.Context, g *models.DeviceGroup) error {
	if g.ID == uuid.Nil {
		g.ID = uuid.New()
	}
	const q = `INSERT INTO device_groups (id, tenant_id, name, description)
	           VALUES ($1, $2, $3, $4)`
	_, err := r.db.ExecContext(ctx, q, g.ID, g.TenantID, g.Name, g.Description)
	return err
}

// Update renames / re-describes a group. nil fields are left unchanged.
func (r *GroupRepo) Update(ctx context.Context, tenantID, id uuid.UUID, name, description *string) error {
	res, err := r.db.ExecContext(ctx, `
		UPDATE device_groups
		   SET name        = COALESCE($1, name),
		       description = COALESCE($2, description),
		       updated_at  = now()
		 WHERE tenant_id = $3 AND id = $4 AND deleted_at IS NULL`, name, description, tenantID, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// Delete soft-deletes a group and clears membership on its devices so they fall
// back to tenant-level policy resolution.
func (r *GroupRepo) Delete(ctx context.Context, tenantID, id uuid.UUID) error {
	tx, err := r.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx, `
		UPDATE device_groups SET deleted_at = now()
		 WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, tenantID, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE devices SET group_id = NULL WHERE tenant_id = $1 AND group_id = $2`, tenantID, id); err != nil {
		return err
	}
	return tx.Commit()
}

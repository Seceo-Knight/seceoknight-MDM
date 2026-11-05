package repository

import (
	"context"
	"database/sql"
	"errors"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/mdm/shared/models"
)

var ErrNotFound = errors.New("not found")

type FileRepo struct{ db *sqlx.DB }

func NewFileRepo(db *sqlx.DB) *FileRepo { return &FileRepo{db: db} }

func (r *FileRepo) Insert(ctx context.Context, f *models.FileObject) error {
	if f.ID == uuid.Nil {
		f.ID = uuid.New()
	}
	const q = `INSERT INTO file_objects
	  (id, tenant_id, name, kind, storage_key, sha256, size_bytes, content_type,
	   uploaded_by, uploaded_by_device, device_id)
	  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`
	_, err := r.db.ExecContext(ctx, q,
		f.ID, f.TenantID, f.Name, f.Kind, f.StorageKey, f.SHA256, f.SizeBytes, f.ContentType,
		f.UploadedBy, f.UploadedByDevice, f.DeviceID)
	return err
}

func (r *FileRepo) Get(ctx context.Context, tenantID, id uuid.UUID) (*models.FileObject, error) {
	const q = `SELECT * FROM file_objects WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`
	out := &models.FileObject{}
	if err := r.db.GetContext(ctx, out, q, tenantID, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

type ListFilter struct {
	TenantID uuid.UUID
	Kind     string
	DeviceID *uuid.UUID
}

func (r *FileRepo) List(ctx context.Context, f ListFilter) ([]models.FileObject, error) {
	args := []any{f.TenantID}
	q := `SELECT * FROM file_objects WHERE tenant_id = $1 AND deleted_at IS NULL`
	if f.Kind != "" {
		args = append(args, f.Kind)
		q += " AND kind = $2"
	}
	if f.DeviceID != nil {
		args = append(args, *f.DeviceID)
		q += " AND device_id = $" + itoa(len(args))
	}
	q += " ORDER BY created_at DESC"
	out := []models.FileObject{}
	err := r.db.SelectContext(ctx, &out, q, args...)
	return out, err
}

// ListAudioSegments returns a recording session's audio segments in play order.
// Segments are named audio_<session>_<zero-padded-seq>_<ts>.aac, so ordering by
// name is sequence order. Scoped to the tenant.
func (r *FileRepo) ListAudioSegments(ctx context.Context, tenantID uuid.UUID, session string) ([]models.FileObject, error) {
	const q = `SELECT * FROM file_objects
	            WHERE tenant_id = $1 AND kind = 'audio' AND deleted_at IS NULL
	              AND name LIKE $2
	            ORDER BY name ASC`
	out := []models.FileObject{}
	// LIKE pattern: audio_<session>_%  (underscores in the literal are fine —
	// session ids don't contain LIKE wildcards we care about here).
	err := r.db.SelectContext(ctx, &out, q, tenantID, "audio_"+session+"_%")
	return out, err
}

func (r *FileRepo) SoftDelete(ctx context.Context, tenantID, id uuid.UUID) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE file_objects SET deleted_at = now() WHERE tenant_id = $1 AND id = $2`,
		tenantID, id)
	return err
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	b := []byte{}
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

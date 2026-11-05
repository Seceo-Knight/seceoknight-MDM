package repository

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/mdm/shared/models"
)

var ErrNotFound = errors.New("not found")

type EnrollmentRepo struct{ db *sqlx.DB }

func NewEnrollmentRepo(db *sqlx.DB) *EnrollmentRepo { return &EnrollmentRepo{db: db} }

func (r *EnrollmentRepo) Create(ctx context.Context, tenantID, createdBy uuid.UUID, policyID *uuid.UUID, oneShot bool, maxUses int, ttl time.Duration, provisioningMode string) (*models.EnrollmentToken, error) {
	tok := make([]byte, 32)
	if _, err := rand.Read(tok); err != nil {
		return nil, err
	}
	if provisioningMode == "" {
		provisioningMode = "device_owner"
	}
	plain := hex.EncodeToString(tok)
	now := time.Now()
	out := &models.EnrollmentToken{
		ID:        uuid.New(),
		TenantID:  tenantID,
		PolicyID:  policyID,
		Token:     plain,
		ProvisioningMode: provisioningMode,
		OneShot:   oneShot,
		MaxUses:   maxUses,
		ExpiresAt: now.Add(ttl),
		CreatedBy: createdBy,
		CreatedAt: now,
	}
	const q = `INSERT INTO enrollment_tokens
	  (id, tenant_id, policy_id, token, provisioning_mode, one_shot, used_count, max_uses, expires_at, created_by)
	  VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9)`
	if _, err := r.db.ExecContext(ctx, q,
		out.ID, out.TenantID, out.PolicyID, out.Token, out.ProvisioningMode, out.OneShot, out.MaxUses, out.ExpiresAt, out.CreatedBy); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *EnrollmentRepo) GetByToken(ctx context.Context, token string) (*models.EnrollmentToken, error) {
	const q = `SELECT id, tenant_id, policy_id, token, provisioning_mode, one_shot, used_count, max_uses,
	                  expires_at, created_by, created_at
	             FROM enrollment_tokens WHERE token = $1`
	out := &models.EnrollmentToken{}
	if err := r.db.GetContext(ctx, out, q, token); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

func (r *EnrollmentRepo) GetByID(ctx context.Context, id uuid.UUID) (*models.EnrollmentToken, error) {
	const q = `SELECT id, tenant_id, policy_id, token, provisioning_mode, one_shot, used_count, max_uses,
	                  expires_at, created_by, created_at
	             FROM enrollment_tokens WHERE id = $1`
	out := &models.EnrollmentToken{}
	if err := r.db.GetContext(ctx, out, q, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

// ConsumeOne atomically increments used_count if the token is still valid.
// Returns the up-to-date token row or ErrNotFound if exhausted/expired.
func (r *EnrollmentRepo) ConsumeOne(ctx context.Context, id uuid.UUID) (*models.EnrollmentToken, error) {
	const q = `
	  UPDATE enrollment_tokens
	     SET used_count = used_count + 1
	   WHERE id = $1
	     AND expires_at > now()
	     AND used_count < max_uses
	  RETURNING id, tenant_id, policy_id, token, provisioning_mode, one_shot, used_count, max_uses, expires_at, created_by, created_at`
	out := &models.EnrollmentToken{}
	if err := r.db.GetContext(ctx, out, q, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

// GetConfig returns the tenant's provisioning config, or ErrNotFound if the
// tenant has never saved one (the service then supplies built-in defaults).
func (r *EnrollmentRepo) GetConfig(ctx context.Context, tenantID uuid.UUID) (*models.EnrollmentConfig, error) {
	const q = `SELECT tenant_id, server_base_url, apk_download_url, apk_signature_checksum, dpc_package_name,
	                  dpc_component_name, wifi_ssid, wifi_password, wifi_security_type,
	                  wifi_hidden, skip_encryption, leave_system_apps, updated_at, updated_by
	             FROM enrollment_config WHERE tenant_id = $1`
	out := &models.EnrollmentConfig{}
	if err := r.db.GetContext(ctx, out, q, tenantID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

// platformDebugPassword reads the single global debug-unlock password row.
// Shared by EnrollmentRepo (enroll-time delivery + admin GET/PUT) and DeviceRepo
// (heartbeat-time refresh). Returns "" when unset.
func platformDebugPassword(ctx context.Context, db *sqlx.DB) (string, error) {
	var pw string
	err := db.GetContext(ctx, &pw, `SELECT debug_unlock_password FROM platform_settings WHERE id = TRUE`)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	return pw, nil
}

// PlatformDebugPassword returns the global debug-unlock password (plaintext, ""
// when unset).
func (r *EnrollmentRepo) PlatformDebugPassword(ctx context.Context) (string, error) {
	return platformDebugPassword(ctx, r.db)
}

// GetPlatformSettings returns the singleton global settings row.
func (r *EnrollmentRepo) GetPlatformSettings(ctx context.Context) (*models.PlatformSettings, error) {
	const q = `SELECT debug_unlock_password, updated_at, updated_by FROM platform_settings WHERE id = TRUE`
	out := &models.PlatformSettings{}
	if err := r.db.GetContext(ctx, out, q); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return &models.PlatformSettings{}, nil
		}
		return nil, err
	}
	return out, nil
}

// UpsertPlatformSettings sets the global debug-unlock password.
func (r *EnrollmentRepo) UpsertPlatformSettings(ctx context.Context, debugPassword string, updatedBy uuid.UUID) error {
	const q = `INSERT INTO platform_settings (id, debug_unlock_password, updated_at, updated_by)
	           VALUES (TRUE, $1, now(), $2)
	           ON CONFLICT (id) DO UPDATE SET
	             debug_unlock_password = EXCLUDED.debug_unlock_password,
	             updated_at            = now(),
	             updated_by            = EXCLUDED.updated_by`
	_, err := r.db.ExecContext(ctx, q, debugPassword, updatedBy)
	return err
}

// UpsertConfig creates or replaces the tenant's provisioning config.
func (r *EnrollmentRepo) UpsertConfig(ctx context.Context, c *models.EnrollmentConfig) error {
	const q = `INSERT INTO enrollment_config
	  (tenant_id, server_base_url, apk_download_url, apk_signature_checksum, dpc_package_name, dpc_component_name,
	   wifi_ssid, wifi_password, wifi_security_type, wifi_hidden, skip_encryption, leave_system_apps,
	   updated_at, updated_by)
	  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), $13)
	  ON CONFLICT (tenant_id) DO UPDATE SET
	    server_base_url        = EXCLUDED.server_base_url,
	    apk_download_url       = EXCLUDED.apk_download_url,
	    apk_signature_checksum = EXCLUDED.apk_signature_checksum,
	    dpc_package_name       = EXCLUDED.dpc_package_name,
	    dpc_component_name     = EXCLUDED.dpc_component_name,
	    wifi_ssid              = EXCLUDED.wifi_ssid,
	    wifi_password          = EXCLUDED.wifi_password,
	    wifi_security_type     = EXCLUDED.wifi_security_type,
	    wifi_hidden            = EXCLUDED.wifi_hidden,
	    skip_encryption        = EXCLUDED.skip_encryption,
	    leave_system_apps      = EXCLUDED.leave_system_apps,
	    updated_at             = now(),
	    updated_by             = EXCLUDED.updated_by`
	_, err := r.db.ExecContext(ctx, q,
		c.TenantID, c.ServerBaseURL, c.APKDownloadURL, c.APKSignatureChecksum, c.DPCPackageName, c.DPCComponentName,
		c.WifiSSID, c.WifiPassword, c.WifiSecurityType, c.WifiHidden, c.SkipEncryption, c.LeaveSystemApps,
		c.UpdatedBy)
	return err
}

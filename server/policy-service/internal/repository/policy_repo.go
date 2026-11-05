package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/mdm/shared/models"
)

var ErrNotFound = errors.New("not found")

type PolicyRepo struct{ db *sqlx.DB }

func NewPolicyRepo(db *sqlx.DB) *PolicyRepo { return &PolicyRepo{db: db} }

// Create or bump version. We never mutate an existing (id,version) row — each
// edit produces version+1. Callers compute the diff against the previous
// version on the read path so the agent can pull a small delta.
func (r *PolicyRepo) CreateOrBumpVersion(ctx context.Context, tenantID, createdBy uuid.UUID, name string, spec json.RawMessage, baseID *uuid.UUID) (*models.Policy, error) {
	var id uuid.UUID
	var nextVer int
	if baseID == nil {
		id = uuid.New()
		nextVer = 1
	} else {
		id = *baseID
		if err := r.db.GetContext(ctx, &nextVer,
			`SELECT COALESCE(MAX(version),0)+1 FROM policies WHERE id = $1`, id); err != nil {
			return nil, err
		}
	}
	const q = `INSERT INTO policies (id, tenant_id, name, version, spec, created_by)
	           VALUES ($1,$2,$3,$4,$5,$6)
	           RETURNING id, tenant_id, name, version, spec, created_by, created_at, updated_at`
	out := &models.Policy{}
	if err := r.db.GetContext(ctx, out, q, id, tenantID, name, nextVer, spec, createdBy); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *PolicyRepo) GetLatest(ctx context.Context, tenantID, id uuid.UUID) (*models.Policy, error) {
	const q = `SELECT id, tenant_id, name, version, spec, created_by, created_at, updated_at
	             FROM policies WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
	            ORDER BY version DESC LIMIT 1`
	out := &models.Policy{}
	if err := r.db.GetContext(ctx, out, q, tenantID, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

func (r *PolicyRepo) GetVersion(ctx context.Context, id uuid.UUID, version int) (*models.Policy, error) {
	const q = `SELECT id, tenant_id, name, version, spec, created_by, created_at, updated_at
	             FROM policies WHERE id = $1 AND version = $2`
	out := &models.Policy{}
	if err := r.db.GetContext(ctx, out, q, id, version); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

func (r *PolicyRepo) ListLatest(ctx context.Context, tenantID uuid.UUID) ([]models.Policy, error) {
	const q = `
	  SELECT DISTINCT ON (id) id, tenant_id, name, version, spec, created_by, created_at, updated_at
	    FROM policies WHERE tenant_id = $1 AND deleted_at IS NULL
	   ORDER BY id, version DESC`
	out := []models.Policy{}
	if err := r.db.SelectContext(ctx, &out, q, tenantID); err != nil {
		return nil, err
	}
	return out, nil
}

// AssignedFor returns the *primary* policy currently bound to a device — the
// most-specific assignment by precedence (device > group > tenant), or the
// most recently assigned if there's a tie. Used as the synthetic "id/version"
// envelope when the service merges all covering policies into one effective
// spec.
func (r *PolicyRepo) AssignedFor(ctx context.Context, tenantID, deviceID uuid.UUID) (*models.Policy, error) {
	const q = `
	  WITH target AS (
	    SELECT d.id AS device_id, d.group_id, d.assigned_policy_id
	      FROM devices d WHERE d.id = $2 AND d.tenant_id = $1
	  ),
	  picked AS (
	    SELECT policy_id FROM policy_assignments pa, target t
	      WHERE pa.tenant_id = $1
	        AND ((pa.target_kind = 'device' AND pa.target_id = t.device_id)
	          OR (pa.target_kind = 'group'  AND pa.target_id = t.group_id)
	          OR (pa.target_kind = 'tenant'))
	      ORDER BY CASE pa.target_kind
	                 WHEN 'device' THEN 1 WHEN 'group' THEN 2 WHEN 'tenant' THEN 3 END,
	               pa.created_at DESC
	      LIMIT 1
	  )
	  SELECT id, tenant_id, name, version, spec, created_by, created_at, updated_at
	    FROM policies
	   WHERE id = (SELECT policy_id FROM picked)
	     AND deleted_at IS NULL
	   ORDER BY version DESC LIMIT 1`
	out := &models.Policy{}
	if err := r.db.GetContext(ctx, out, q, tenantID, deviceID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

// AssignedSpecsForDevice returns *all* policies currently covering a device,
// ordered from lowest- to highest-precedence (tenant → group → device, oldest
// first within a level). The service layer merges these specs to produce the
// effective policy the agent applies.
func (r *PolicyRepo) AssignedSpecsForDevice(ctx context.Context, tenantID, deviceID uuid.UUID) ([]models.Policy, error) {
	const q = `
	  WITH target AS (
	    SELECT d.id AS device_id, d.group_id
	      FROM devices d WHERE d.id = $2 AND d.tenant_id = $1
	  ),
	  covering AS (
	    SELECT DISTINCT ON (pa.policy_id)
	           pa.policy_id, pa.target_kind, pa.created_at
	      FROM policy_assignments pa, target t
	     WHERE pa.tenant_id = $1
	       AND ((pa.target_kind = 'device' AND pa.target_id = t.device_id)
	         OR (pa.target_kind = 'group'  AND pa.target_id = t.group_id)
	         OR (pa.target_kind = 'tenant'))
	  )
	  SELECT p.id, p.tenant_id, p.name, p.version, p.spec, p.created_by, p.created_at, p.updated_at
	    FROM covering c
	    JOIN LATERAL (
	      SELECT id, tenant_id, name, version, spec, created_by, created_at, updated_at
	        FROM policies
	       WHERE id = c.policy_id AND deleted_at IS NULL
	       ORDER BY version DESC LIMIT 1
	    ) p ON true
	   ORDER BY CASE c.target_kind
	              WHEN 'tenant' THEN 1 WHEN 'group' THEN 2 WHEN 'device' THEN 3
	            END,
	            c.created_at ASC`
	out := []models.Policy{}
	if err := r.db.SelectContext(ctx, &out, q, tenantID, deviceID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return out, nil
		}
		return nil, err
	}
	return out, nil
}

// ListAssignmentsForTarget returns every assignment row attached to a
// (device | group | tenant) target — used by the admin UI to render the
// stack of policies a device has applied.
func (r *PolicyRepo) ListAssignmentsForTarget(ctx context.Context, tenantID uuid.UUID, kind string, targetID *uuid.UUID) ([]models.PolicyAssignment, error) {
	var rows []models.PolicyAssignment
	const qWithID = `SELECT id, tenant_id, policy_id, target_kind, target_id, created_at
	                   FROM policy_assignments
	                  WHERE tenant_id = $1 AND target_kind = $2 AND target_id = $3
	                  ORDER BY created_at DESC`
	const qNullID = `SELECT id, tenant_id, policy_id, target_kind, target_id, created_at
	                   FROM policy_assignments
	                  WHERE tenant_id = $1 AND target_kind = $2 AND target_id IS NULL
	                  ORDER BY created_at DESC`
	if targetID != nil {
		if err := r.db.SelectContext(ctx, &rows, qWithID, tenantID, kind, *targetID); err != nil {
			return nil, err
		}
	} else {
		if err := r.db.SelectContext(ctx, &rows, qNullID, tenantID, kind); err != nil {
			return nil, err
		}
	}
	return rows, nil
}

// ListAssignmentsCoveringDevice returns assignment rows from every level
// (device + group + tenant) that currently bind a policy onto this device.
// Used so the UI's per-device PolicyTab can show layered assignments
// regardless of which target_kind owns them.
func (r *PolicyRepo) ListAssignmentsCoveringDevice(ctx context.Context, tenantID, deviceID uuid.UUID) ([]models.PolicyAssignment, error) {
	const q = `
	  WITH target AS (
	    SELECT d.id AS device_id, d.group_id
	      FROM devices d WHERE d.id = $2 AND d.tenant_id = $1
	  )
	  SELECT pa.id, pa.tenant_id, pa.policy_id, pa.target_kind, pa.target_id, pa.created_at
	    FROM policy_assignments pa, target t
	   WHERE pa.tenant_id = $1
	     AND ((pa.target_kind = 'device' AND pa.target_id = t.device_id)
	       OR (pa.target_kind = 'group'  AND pa.target_id = t.group_id)
	       OR (pa.target_kind = 'tenant'))
	   ORDER BY CASE pa.target_kind
	              WHEN 'device' THEN 1 WHEN 'group' THEN 2 WHEN 'tenant' THEN 3
	            END,
	            pa.created_at DESC`
	rows := []models.PolicyAssignment{}
	if err := r.db.SelectContext(ctx, &rows, q, tenantID, deviceID); err != nil {
		return nil, err
	}
	return rows, nil
}

func (r *PolicyRepo) Assign(ctx context.Context, tenantID, policyID uuid.UUID, targetKind string, targetID *uuid.UUID) error {
	// Multi-assign: a target can have many policies layered onto it; the
	// service merges their specs at read time. Idempotent on duplicate
	// (tenant, policy, target) tuples thanks to the unique constraint in
	// 013_policy_multi_assign.sql.
	if targetID != nil {
		_, err := r.db.ExecContext(ctx,
			`INSERT INTO policy_assignments (tenant_id, policy_id, target_kind, target_id)
			      VALUES ($1,$2,$3,$4)
			 ON CONFLICT (tenant_id, policy_id, target_kind, (COALESCE(target_id, '00000000-0000-0000-0000-000000000000'))) DO NOTHING`,
			tenantID, policyID, targetKind, *targetID)
		return err
	}
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO policy_assignments (tenant_id, policy_id, target_kind, target_id)
		      VALUES ($1,$2,$3,NULL)
		 ON CONFLICT (tenant_id, policy_id, target_kind, (COALESCE(target_id, '00000000-0000-0000-0000-000000000000'))) DO NOTHING`,
		tenantID, policyID, targetKind)
	return err
}

func (r *PolicyRepo) Unassign(ctx context.Context, tenantID, policyID uuid.UUID, targetKind string, targetID *uuid.UUID) error {
	if targetID != nil {
		_, err := r.db.ExecContext(ctx,
			`DELETE FROM policy_assignments
			       WHERE tenant_id = $1 AND policy_id = $2
			         AND target_kind = $3 AND target_id = $4`,
			tenantID, policyID, targetKind, *targetID)
		return err
	}
	_, err := r.db.ExecContext(ctx,
		`DELETE FROM policy_assignments
		       WHERE tenant_id = $1 AND policy_id = $2
		         AND target_kind = $3 AND target_id IS NULL`,
		tenantID, policyID, targetKind)
	return err
}

func (r *PolicyRepo) ListAssignments(ctx context.Context, tenantID, policyID uuid.UUID) ([]models.PolicyAssignment, error) {
	const q = `SELECT id, tenant_id, policy_id, target_kind, target_id, created_at
	             FROM policy_assignments WHERE tenant_id = $1 AND policy_id = $2
	            ORDER BY created_at DESC`
	out := []models.PolicyAssignment{}
	if err := r.db.SelectContext(ctx, &out, q, tenantID, policyID); err != nil {
		return nil, err
	}
	return out, nil
}

// IssueApplyPolicyForTarget inserts a pending APPLY_POLICY command into the
// commands table for every device this assignment covers. The command-service
// dispatcher picks them up on its next reconciliation tick and pushes them
// over MQTT. We do the insert directly here rather than HTTP-roundtripping to
// command-service to keep assign latency tight.
func (r *PolicyRepo) IssueApplyPolicyForTarget(ctx context.Context, tenantID uuid.UUID, kind string, targetID *uuid.UUID, createdBy uuid.UUID) (int, error) {
	var deviceIDs []uuid.UUID
	switch kind {
	case "device":
		if targetID == nil {
			return 0, nil
		}
		deviceIDs = []uuid.UUID{*targetID}
	case "group":
		if targetID == nil {
			return 0, nil
		}
		if err := r.db.SelectContext(ctx, &deviceIDs,
			`SELECT id FROM devices WHERE tenant_id=$1 AND group_id=$2 AND deleted_at IS NULL AND state <> 'retired'`,
			tenantID, *targetID); err != nil {
			return 0, err
		}
	case "tenant":
		if err := r.db.SelectContext(ctx, &deviceIDs,
			`SELECT id FROM devices WHERE tenant_id=$1 AND deleted_at IS NULL AND state <> 'retired'`,
			tenantID); err != nil {
			return 0, err
		}
	default:
		return 0, nil
	}
	const q = `INSERT INTO commands (id, tenant_id, device_id, kind, payload, state, max_attempts, timeout_at, created_by)
	           VALUES (uuid_generate_v4(), $1, $2, 'APPLY_POLICY', '{}'::jsonb, 'pending', 3, now() + interval '10 minutes', $3)`
	for _, did := range deviceIDs {
		if _, err := r.db.ExecContext(ctx, q, tenantID, did, createdBy); err != nil {
			return 0, err
		}
	}
	return len(deviceIDs), nil
}

// DevicesForTarget returns the device IDs a (kind,targetID) pair currently
// resolves to — same expansion the apply/clear path uses, exposed so the
// service layer can iterate them after an unassign/delete and decide per-
// device whether to fire APPLY_POLICY (still has other policies) or
// CLEAR_POLICY (now bare).
func (r *PolicyRepo) DevicesForTarget(ctx context.Context, tenantID uuid.UUID, kind string, targetID *uuid.UUID) ([]uuid.UUID, error) {
	var deviceIDs []uuid.UUID
	switch kind {
	case "device":
		if targetID == nil {
			return nil, nil
		}
		deviceIDs = []uuid.UUID{*targetID}
	case "group":
		if targetID == nil {
			return nil, nil
		}
		if err := r.db.SelectContext(ctx, &deviceIDs,
			`SELECT id FROM devices WHERE tenant_id=$1 AND group_id=$2 AND deleted_at IS NULL AND state <> 'retired'`,
			tenantID, *targetID); err != nil {
			return nil, err
		}
	case "tenant":
		if err := r.db.SelectContext(ctx, &deviceIDs,
			`SELECT id FROM devices WHERE tenant_id=$1 AND deleted_at IS NULL AND state <> 'retired'`,
			tenantID); err != nil {
			return nil, err
		}
	}
	return deviceIDs, nil
}

// DeviceStillHasAssignments reports whether the device still has any policy
// assignment covering it after a remove. Used to choose APPLY_POLICY (re-apply
// the new merged spec) vs CLEAR_POLICY (no more policies — roll back fully).
func (r *PolicyRepo) DeviceStillHasAssignments(ctx context.Context, tenantID, deviceID uuid.UUID) (bool, error) {
	var n int
	const q = `
	  WITH target AS (
	    SELECT d.id AS device_id, d.group_id FROM devices d
	      WHERE d.id = $2 AND d.tenant_id = $1
	  )
	  SELECT COUNT(*) FROM policy_assignments pa, target t
	   WHERE pa.tenant_id = $1
	     AND ((pa.target_kind = 'device' AND pa.target_id = t.device_id)
	       OR (pa.target_kind = 'group'  AND pa.target_id = t.group_id)
	       OR (pa.target_kind = 'tenant'))`
	if err := r.db.GetContext(ctx, &n, q, tenantID, deviceID); err != nil {
		return false, err
	}
	return n > 0, nil
}

// IssueApplyPolicyForDevices inserts an APPLY_POLICY command per given device id.
func (r *PolicyRepo) IssueApplyPolicyForDevices(ctx context.Context, tenantID, createdBy uuid.UUID, deviceIDs []uuid.UUID) (int, error) {
	const q = `INSERT INTO commands (id, tenant_id, device_id, kind, payload, state, max_attempts, timeout_at, created_by)
	           VALUES (uuid_generate_v4(), $1, $2, 'APPLY_POLICY', '{}'::jsonb, 'pending', 3, now() + interval '10 minutes', $3)`
	for _, did := range deviceIDs {
		if _, err := r.db.ExecContext(ctx, q, tenantID, did, createdBy); err != nil {
			return 0, err
		}
	}
	return len(deviceIDs), nil
}

// IssueClearPolicyForDevices inserts a CLEAR_POLICY command per given device id.
func (r *PolicyRepo) IssueClearPolicyForDevices(ctx context.Context, tenantID, createdBy uuid.UUID, deviceIDs []uuid.UUID) (int, error) {
	const q = `INSERT INTO commands (id, tenant_id, device_id, kind, payload, state, max_attempts, timeout_at, created_by)
	           VALUES (uuid_generate_v4(), $1, $2, 'CLEAR_POLICY', '{}'::jsonb, 'pending', 3, now() + interval '10 minutes', $3)`
	for _, did := range deviceIDs {
		if _, err := r.db.ExecContext(ctx, q, tenantID, did, createdBy); err != nil {
			return 0, err
		}
	}
	return len(deviceIDs), nil
}

// IssueClearPolicyForTarget mirrors IssueApplyPolicyForTarget but inserts a
// CLEAR_POLICY command — fired from Unassign so the device actively rolls
// back the policy-enforced settings (camera-disable, blocklists, surveillance
// flags) instead of being left in the "last applied" state forever.
//
// Targets devices the assignment USED TO cover. For "device" we already have
// the id directly; for "group" and "tenant" we re-resolve the same membership
// rules the apply path used. Idempotent: even devices that hadn't received
// the policy yet will see CLEAR_POLICY and just no-op the un-set fields.
func (r *PolicyRepo) IssueClearPolicyForTarget(ctx context.Context, tenantID uuid.UUID, kind string, targetID *uuid.UUID, createdBy uuid.UUID) (int, error) {
	var deviceIDs []uuid.UUID
	switch kind {
	case "device":
		if targetID == nil {
			return 0, nil
		}
		deviceIDs = []uuid.UUID{*targetID}
	case "group":
		if targetID == nil {
			return 0, nil
		}
		if err := r.db.SelectContext(ctx, &deviceIDs,
			`SELECT id FROM devices WHERE tenant_id=$1 AND group_id=$2 AND deleted_at IS NULL AND state <> 'retired'`,
			tenantID, *targetID); err != nil {
			return 0, err
		}
	case "tenant":
		if err := r.db.SelectContext(ctx, &deviceIDs,
			`SELECT id FROM devices WHERE tenant_id=$1 AND deleted_at IS NULL AND state <> 'retired'`,
			tenantID); err != nil {
			return 0, err
		}
	default:
		return 0, nil
	}
	const q = `INSERT INTO commands (id, tenant_id, device_id, kind, payload, state, max_attempts, timeout_at, created_by)
	           VALUES (uuid_generate_v4(), $1, $2, 'CLEAR_POLICY', '{}'::jsonb, 'pending', 3, now() + interval '10 minutes', $3)`
	for _, did := range deviceIDs {
		if _, err := r.db.ExecContext(ctx, q, tenantID, did, createdBy); err != nil {
			return 0, err
		}
	}
	return len(deviceIDs), nil
}

func (r *PolicyRepo) SoftDelete(ctx context.Context, tenantID, id uuid.UUID) error {
	tx, err := r.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`UPDATE policies SET deleted_at = now() WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
		tenantID, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM policy_assignments WHERE tenant_id = $1 AND policy_id = $2`, tenantID, id); err != nil {
		return err
	}
	return tx.Commit()
}

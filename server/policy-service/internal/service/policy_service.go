package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/mdm/policy-service/internal/repository"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/events"
	"github.com/mdm/shared/models"
	"github.com/mdm/shared/mq"
)

type PolicyService struct {
	repo *repository.PolicyRepo
	bus  *mq.Bus
}

func NewPolicyService(r *repository.PolicyRepo, bus *mq.Bus) *PolicyService {
	return &PolicyService{repo: r, bus: bus}
}

type UpsertInput struct {
	BaseID    *uuid.UUID
	TenantID  uuid.UUID
	CreatedBy uuid.UUID
	Name      string
	Spec      json.RawMessage
}

func (s *PolicyService) Upsert(ctx context.Context, in UpsertInput) (*models.Policy, error) {
	if !json.Valid(in.Spec) {
		return nil, apperr.New(apperr.CodeInvalidInput, "spec must be valid JSON")
	}
	normalized, err := normalizeSpec(in.Spec)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInvalidInput, "normalize spec", err)
	}
	in.Spec = normalized
	p, err := s.repo.CreateOrBumpVersion(ctx, in.TenantID, in.CreatedBy, in.Name, in.Spec, in.BaseID)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "save policy", err)
	}
	meta, _ := json.Marshal(map[string]any{"name": p.Name, "version": p.Version})
	events.Emit(ctx, s.bus, events.AuditEnvelope{
		TenantID:   p.TenantID.String(),
		ActorID:    events.UUIDStrPtr(in.CreatedBy),
		ActorKind:  "user",
		Action:     "policy.upserted",
		TargetKind: events.StrPtr("policy"),
		TargetID:   events.UUIDStrPtr(p.ID),
		Metadata:   meta,
	})
	return p, nil
}

// normalizeSpec moves a handful of well-known fields people sometimes write at
// the top level into their canonical nested location, so the agent (which
// decodes with ignoreUnknownKeys=true and would otherwise silently drop them)
// actually sees them. Currently handles:
//   - url_blocklist  → apps.url_blocklist   (Chrome / browser URL blocklist)
//   - blocklist      → apps.blocklist        (Android app package blocklist)
//
// This is a defensive normalization for hand-written specs; the structured
// UI editor builds the canonical shape directly so it doesn't trip this path.
func normalizeSpec(raw json.RawMessage) (json.RawMessage, error) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	changed := false
	moveInto := func(srcKey, dstKey string) {
		v, ok := m[srcKey]
		if !ok {
			return
		}
		appsAny, _ := m["apps"].(map[string]any)
		if appsAny == nil {
			appsAny = map[string]any{}
		}
		if _, exists := appsAny[dstKey]; !exists {
			appsAny[dstKey] = v
		}
		m["apps"] = appsAny
		delete(m, srcKey)
		changed = true
	}
	moveInto("url_blocklist", "url_blocklist")
	moveInto("blocklist", "blocklist")
	if !changed {
		return raw, nil
	}
	out, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (s *PolicyService) GetLatest(ctx context.Context, tenantID, id uuid.UUID) (*models.Policy, error) {
	p, err := s.repo.GetLatest(ctx, tenantID, id)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, apperr.New(apperr.CodeNotFound, "policy not found")
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "get policy", err)
	}
	return p, nil
}

func (s *PolicyService) List(ctx context.Context, tenantID uuid.UUID) ([]models.Policy, error) {
	return s.repo.ListLatest(ctx, tenantID)
}

// Diff returns the JSON merge-patch (RFC 7396) between two policy versions.
// The Android agent applies only the diff so it can be small for large policies.
func (s *PolicyService) Diff(ctx context.Context, id uuid.UUID, from, to int) (json.RawMessage, error) {
	if from == to {
		return json.RawMessage("{}"), nil
	}
	fromP, err := s.repo.GetVersion(ctx, id, from)
	if err != nil && !errors.Is(err, repository.ErrNotFound) {
		return nil, apperr.Wrap(apperr.CodeInternal, "get policy from", err)
	}
	toP, err := s.repo.GetVersion(ctx, id, to)
	if err != nil {
		return nil, apperr.New(apperr.CodeNotFound, "target policy version not found")
	}
	var fromJSON, toJSON map[string]any
	if fromP != nil {
		_ = json.Unmarshal(fromP.Spec, &fromJSON)
	}
	_ = json.Unmarshal(toP.Spec, &toJSON)
	patch := mergePatch(fromJSON, toJSON)
	out, _ := json.Marshal(patch)
	return out, nil
}

// mergePatch produces a JSON merge patch that transforms `from` into `to`.
// keys removed from `to` become explicit nulls per RFC 7396.
func mergePatch(from, to map[string]any) map[string]any {
	patch := map[string]any{}
	for k, v := range to {
		fv, ok := from[k]
		if !ok || !deepEqual(fv, v) {
			if fm, fok := fv.(map[string]any); fok {
				if tm, tok := v.(map[string]any); tok {
					patch[k] = mergePatch(fm, tm)
					continue
				}
			}
			patch[k] = v
		}
	}
	for k := range from {
		if _, ok := to[k]; !ok {
			patch[k] = nil
		}
	}
	return patch
}

func deepEqual(a, b any) bool {
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	return string(ja) == string(jb)
}

// AssignedFor returns the effective policy for a device: the deep-merge of
// every policy currently assigned at tenant/group/device level, with device
// overriding group overriding tenant for scalar/object keys and array fields
// unioning across all layers (so blocking YouTube via one policy and Facebook
// via another both apply on the phone).
//
// The returned Policy is a synthetic envelope:
//   - id     := highest-precedence source policy's id (stable per device while
//                the set of bound policies doesn't change)
//   - version:= hash-derived integer over the sorted (id, version) list so the
//                agent's "applied_policy_version" round-trip still detects when
//                the merged set changed
//   - name   := joined names ("policyA + policyB")
//   - spec   := merged JSON
func (s *PolicyService) AssignedFor(ctx context.Context, tenantID, deviceID uuid.UUID) (*models.Policy, error) {
	specs, err := s.repo.AssignedSpecsForDevice(ctx, tenantID, deviceID)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "assigned specs", err)
	}
	if len(specs) == 0 {
		return nil, apperr.New(apperr.CodeNotFound, "no policy assigned")
	}
	// Single-policy fast path keeps the wire shape identical to pre-multi.
	if len(specs) == 1 {
		return &specs[0], nil
	}
	merged := mergeSpecs(specs)
	envelope := specs[len(specs)-1] // highest-precedence source (sorted asc)
	envelope.Spec = merged
	envelope.Version = effectiveVersion(specs)
	envelope.Name = joinNames(specs)
	return &envelope, nil
}

// mergeSpecs deep-merges []policy.spec in the order given (lowest precedence
// first). Objects are recursively merged; arrays are unioned (dedupe by JSON
// representation); scalars and other types are replaced.
func mergeSpecs(ps []models.Policy) json.RawMessage {
	acc := map[string]any{}
	for _, p := range ps {
		var m map[string]any
		if err := json.Unmarshal(p.Spec, &m); err != nil {
			continue
		}
		deepMerge(acc, m)
	}
	out, _ := json.Marshal(acc)
	return out
}

func deepMerge(dst, src map[string]any) {
	for k, v := range src {
		if dv, ok := dst[k]; ok {
			if dm, dok := dv.(map[string]any); dok {
				if sm, sok := v.(map[string]any); sok {
					deepMerge(dm, sm)
					continue
				}
			}
			if da, dok := dv.([]any); dok {
				if sa, sok := v.([]any); sok {
					dst[k] = unionArrays(da, sa)
					continue
				}
			}
		}
		dst[k] = v
	}
}

func unionArrays(a, b []any) []any {
	seen := map[string]struct{}{}
	out := make([]any, 0, len(a)+len(b))
	for _, x := range a {
		j, _ := json.Marshal(x)
		if _, ok := seen[string(j)]; ok {
			continue
		}
		seen[string(j)] = struct{}{}
		out = append(out, x)
	}
	for _, x := range b {
		j, _ := json.Marshal(x)
		if _, ok := seen[string(j)]; ok {
			continue
		}
		seen[string(j)] = struct{}{}
		out = append(out, x)
	}
	return out
}

// effectiveVersion: deterministic int derived from the sorted (id,version)
// set so the agent's applied_policy_version round-trip changes whenever the
// merged set changes.
func effectiveVersion(ps []models.Policy) int {
	// 32-bit FNV-1a, kept positive so the int field stays clean.
	var h uint32 = 2166136261
	for _, p := range ps {
		s := fmt.Sprintf("%s:%d|", p.ID, p.Version)
		for i := 0; i < len(s); i++ {
			h ^= uint32(s[i])
			h *= 16777619
		}
	}
	return int(h & 0x7fffffff)
}

func joinNames(ps []models.Policy) string {
	out := ""
	for i, p := range ps {
		if i > 0 {
			out += " + "
		}
		out += p.Name
	}
	return out
}

func (s *PolicyService) Assign(ctx context.Context, tenantID, policyID uuid.UUID, kind string, targetID *uuid.UUID, createdBy uuid.UUID) error {
	if kind != "device" && kind != "group" && kind != "tenant" {
		return apperr.New(apperr.CodeInvalidInput, "invalid target_kind")
	}
	if err := s.repo.Assign(ctx, tenantID, policyID, kind, targetID); err != nil {
		return apperr.Wrap(apperr.CodeInternal, "assign", err)
	}
	// Auto-fire APPLY_POLICY at every device the assignment newly covers so
	// the admin doesn't have to click an extra button — the policy actually
	// rolls out immediately.
	issued, err := s.repo.IssueApplyPolicyForTarget(ctx, tenantID, kind, targetID, createdBy)
	if err != nil {
		// Audit the partial failure but don't fail the whole assign call.
		events.Emit(ctx, s.bus, events.AuditEnvelope{
			TenantID:  tenantID.String(),
			ActorKind: "system",
			Action:    "policy.autoapply.failed",
		})
	}
	meta, _ := json.Marshal(map[string]any{
		"policy_id":   policyID.String(),
		"target_kind": kind,
		"target_id":   targetID,
		"auto_applied_devices": issued,
	})
	tid := events.UUIDStrPtr(policyID)
	if targetID != nil {
		tid = events.UUIDStrPtr(*targetID)
	}
	events.Emit(ctx, s.bus, events.AuditEnvelope{
		TenantID:   tenantID.String(),
		ActorID:    events.UUIDStrPtr(createdBy),
		ActorKind:  "user",
		Action:     "policy.assigned." + kind,
		TargetKind: events.StrPtr(kind),
		TargetID:   tid,
		Metadata:   meta,
	})
	return nil
}

func (s *PolicyService) Unassign(ctx context.Context, tenantID, policyID uuid.UUID, kind string, targetID *uuid.UUID, createdBy uuid.UUID) error {
	if kind != "device" && kind != "group" && kind != "tenant" {
		return apperr.New(apperr.CodeInvalidInput, "invalid target_kind")
	}
	// Capture the devices the target USED TO cover before we delete the row.
	devices, _ := s.repo.DevicesForTarget(ctx, tenantID, kind, targetID)
	if err := s.repo.Unassign(ctx, tenantID, policyID, kind, targetID); err != nil {
		return apperr.Wrap(apperr.CodeInternal, "unassign", err)
	}
	applied, cleared := s.reconcileAfterRemoval(ctx, tenantID, createdBy, devices)
	tid := events.StrPtr("")
	if targetID != nil {
		tid = events.UUIDStrPtr(*targetID)
	}
	meta, _ := json.Marshal(map[string]any{
		"policy_id":            policyID.String(),
		"target_kind":          kind,
		"target_id":            targetID,
		"auto_cleared_devices": cleared,
		"auto_reapplied_devices": applied,
	})
	events.Emit(ctx, s.bus, events.AuditEnvelope{
		TenantID:   tenantID.String(),
		ActorID:    events.UUIDStrPtr(createdBy),
		ActorKind:  "user",
		Action:     "policy.unassigned." + kind,
		TargetKind: events.StrPtr(kind),
		TargetID:   tid,
		Metadata:   meta,
	})
	return nil
}

// reconcileAfterRemoval iterates devices that USED TO be covered by an
// unassign/delete and issues:
//   - APPLY_POLICY  if the device still has other assignments → agent will
//                   fetch the new merged spec and reconcile.
//   - CLEAR_POLICY  if the device is now bare → agent rolls back everything.
//
// Returns (appliedCount, clearedCount).
func (s *PolicyService) reconcileAfterRemoval(ctx context.Context, tenantID, createdBy uuid.UUID, devices []uuid.UUID) (int, int) {
	var stillBound, bare []uuid.UUID
	for _, did := range devices {
		ok, err := s.repo.DeviceStillHasAssignments(ctx, tenantID, did)
		if err != nil {
			continue
		}
		if ok {
			stillBound = append(stillBound, did)
		} else {
			bare = append(bare, did)
		}
	}
	applied, _ := s.repo.IssueApplyPolicyForDevices(ctx, tenantID, createdBy, stillBound)
	cleared, _ := s.repo.IssueClearPolicyForDevices(ctx, tenantID, createdBy, bare)
	return applied, cleared
}

func (s *PolicyService) ListAssignments(ctx context.Context, tenantID, policyID uuid.UUID) ([]models.PolicyAssignment, error) {
	return s.repo.ListAssignments(ctx, tenantID, policyID)
}

func (s *PolicyService) Delete(ctx context.Context, tenantID, id uuid.UUID, createdBy uuid.UUID) error {
	// Capture every device USED TO be covered by this policy's assignments
	// before SoftDelete removes them — once the rows are gone we can't ask
	// repo who they covered.
	priorAssignments, _ := s.repo.ListAssignments(ctx, tenantID, id)
	priorDevices := map[uuid.UUID]struct{}{}
	for _, a := range priorAssignments {
		devs, err := s.repo.DevicesForTarget(ctx, tenantID, a.TargetKind, a.TargetID)
		if err != nil {
			continue
		}
		for _, d := range devs {
			priorDevices[d] = struct{}{}
		}
	}
	if err := s.repo.SoftDelete(ctx, tenantID, id); err != nil {
		return apperr.Wrap(apperr.CodeInternal, "delete policy", err)
	}
	devices := make([]uuid.UUID, 0, len(priorDevices))
	for d := range priorDevices {
		devices = append(devices, d)
	}
	applied, cleared := s.reconcileAfterRemoval(ctx, tenantID, createdBy, devices)
	meta, _ := json.Marshal(map[string]any{
		"auto_cleared_devices":   cleared,
		"auto_reapplied_devices": applied,
		"assignment_count":       len(priorAssignments),
	})
	events.Emit(ctx, s.bus, events.AuditEnvelope{
		TenantID:   tenantID.String(),
		ActorID:    events.UUIDStrPtr(createdBy),
		ActorKind:  "user",
		Action:     "policy.deleted",
		TargetKind: events.StrPtr("policy"),
		TargetID:   events.UUIDStrPtr(id),
		Metadata:   meta,
	})
	return nil
}

// AssignmentsForDevice returns the full stack of assignment rows binding a
// policy onto a device — used by the admin UI to render the layered policies
// the device is subject to.
func (s *PolicyService) AssignmentsForDevice(ctx context.Context, tenantID, deviceID uuid.UUID) ([]models.PolicyAssignment, error) {
	return s.repo.ListAssignmentsCoveringDevice(ctx, tenantID, deviceID)
}

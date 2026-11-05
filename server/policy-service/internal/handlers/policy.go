package handlers

import (
	"encoding/json"
	"strconv"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/mdm/policy-service/internal/service"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/middleware"
)

type PolicyHandler struct{ svc *service.PolicyService }

func NewPolicyHandler(s *service.PolicyService) *PolicyHandler { return &PolicyHandler{svc: s} }

type upsertReq struct {
	ID   *string         `json:"id,omitempty"`
	Name string          `json:"name"`
	Spec json.RawMessage `json:"spec"`
}

func (h *PolicyHandler) Upsert(c *fiber.Ctx) error {
	var req upsertReq
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed body"})
	}
	if req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"error": "name required"})
	}
	var base *uuid.UUID
	if req.ID != nil {
		id, err := uuid.Parse(*req.ID)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
		}
		base = &id
	}
	tenantID := tenantOf(c)
	userID := userOf(c)
	p, err := h.svc.Upsert(c.Context(), service.UpsertInput{
		BaseID: base, TenantID: tenantID, CreatedBy: userID, Name: req.Name, Spec: req.Spec,
	})
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.Status(201).JSON(p)
}

func (h *PolicyHandler) List(c *fiber.Ctx) error {
	items, err := h.svc.List(c.Context(), tenantOf(c))
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"items": items})
}

func (h *PolicyHandler) Get(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	p, err := h.svc.GetLatest(c.Context(), tenantOf(c), id)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(p)
}

func (h *PolicyHandler) Diff(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	from, _ := strconv.Atoi(c.Query("from"))
	to, _ := strconv.Atoi(c.Query("to"))
	if to == 0 {
		return c.Status(400).JSON(fiber.Map{"error": "to required"})
	}
	patch, err := h.svc.Diff(c.Context(), id, from, to)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	c.Set("Content-Type", "application/json")
	return c.Send(patch)
}

func (h *PolicyHandler) AssignedForDevice(c *fiber.Ctx) error {
	deviceStr, _ := c.Locals(middleware.CtxDeviceID).(string)
	deviceID, err := uuid.Parse(deviceStr)
	if err != nil {
		return c.Status(401).JSON(fiber.Map{"error": "device required"})
	}
	p, err := h.svc.AssignedFor(c.Context(), tenantOf(c), deviceID)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(p)
}

// ResolvedForDevice is the admin-facing counterpart to AssignedForDevice — it
// returns whichever policy currently resolves for a device under the standard
// device → group → tenant precedence. 404 if none.
func (h *PolicyHandler) ResolvedForDevice(c *fiber.Ctx) error {
	deviceID, err := uuid.Parse(c.Params("deviceID"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid deviceID"})
	}
	p, err := h.svc.AssignedFor(c.Context(), tenantOf(c), deviceID)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(p)
}

type assignReq struct {
	PolicyID   string  `json:"policy_id"`
	TargetKind string  `json:"target_kind"`
	TargetID   *string `json:"target_id,omitempty"`
}

func (h *PolicyHandler) Assign(c *fiber.Ctx) error {
	var req assignReq
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed"})
	}
	pid, err := uuid.Parse(req.PolicyID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid policy_id"})
	}
	var tid *uuid.UUID
	if req.TargetID != nil {
		t, err := uuid.Parse(*req.TargetID)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "invalid target_id"})
		}
		tid = &t
	}
	if err := h.svc.Assign(c.Context(), tenantOf(c), pid, req.TargetKind, tid, userOf(c)); err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(204)
}

type unassignReq struct {
	PolicyID   string  `json:"policy_id"`
	TargetKind string  `json:"target_kind"`
	TargetID   *string `json:"target_id,omitempty"`
}

func (h *PolicyHandler) Unassign(c *fiber.Ctx) error {
	var req unassignReq
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed"})
	}
	pid, err := uuid.Parse(req.PolicyID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "policy_id required"})
	}
	var tid *uuid.UUID
	if req.TargetID != nil {
		t, err := uuid.Parse(*req.TargetID)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "invalid target_id"})
		}
		tid = &t
	}
	if err := h.svc.Unassign(c.Context(), tenantOf(c), pid, req.TargetKind, tid, userOf(c)); err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(204)
}

// AssignmentsForDevice returns every assignment row currently binding any
// policy onto this device (across tenant/group/device target_kinds). The
// admin UI's per-device Policy tab consumes this to render the layered
// stack.
func (h *PolicyHandler) AssignmentsForDevice(c *fiber.Ctx) error {
	deviceID, err := uuid.Parse(c.Params("deviceID"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid deviceID"})
	}
	items, err := h.svc.AssignmentsForDevice(c.Context(), tenantOf(c), deviceID)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"items": items})
}

func (h *PolicyHandler) ListAssignments(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	items, err := h.svc.ListAssignments(c.Context(), tenantOf(c), id)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"items": items})
}

func (h *PolicyHandler) Delete(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	if err := h.svc.Delete(c.Context(), tenantOf(c), id, userOf(c)); err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(204)
}

func tenantOf(c *fiber.Ctx) uuid.UUID {
	s, _ := c.Locals(middleware.CtxTenantID).(string)
	t, _ := uuid.Parse(s)
	return t
}
func userOf(c *fiber.Ctx) uuid.UUID {
	s, _ := c.Locals(middleware.CtxUserID).(string)
	t, _ := uuid.Parse(s)
	return t
}

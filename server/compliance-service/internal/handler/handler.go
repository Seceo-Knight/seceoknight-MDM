// Package handler provides Fiber HTTP handlers for the compliance service.
package handler

import (
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/mdm/compliance-service/internal/store"
	"github.com/mdm/shared/middleware"
)

// Handler holds the store and exposes Fiber handler methods.
type Handler struct {
	store *store.Store
}

func New(s *store.Store) *Handler { return &Handler{store: s} }

// tenantID extracts the validated tenant UUID from Fiber locals.
func tenantID(c *fiber.Ctx) (uuid.UUID, error) {
	raw, _ := c.Locals(middleware.CtxTenantID).(string)
	return uuid.Parse(raw)
}

// userID extracts the calling user UUID from Fiber locals.
func userID(c *fiber.Ctx) *uuid.UUID {
	raw, _ := c.Locals(middleware.CtxUserID).(string)
	id, err := uuid.Parse(raw)
	if err != nil {
		return nil
	}
	return &id
}

// ─── Rules ────────────────────────────────────────────────────────────────────

// ListRules GET /api/v1/compliance/rules
func (h *Handler) ListRules(c *fiber.Ctx) error {
	tid, err := tenantID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid tenant")
	}
	rules, err := h.store.ListRules(c.Context(), tid)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	if rules == nil {
		rules = []store.Rule{}
	}
	return c.JSON(fiber.Map{"rules": rules})
}

type ruleInput struct {
	Name            string          `json:"name"`
	Description     string          `json:"description"`
	TriggerField    string          `json:"trigger_field"`
	Operator        string          `json:"operator"`
	Threshold       float64         `json:"threshold"`
	Action          string          `json:"action"`
	ActionPayload   json.RawMessage `json:"action_payload"`
	CooldownMinutes int             `json:"cooldown_minutes"`
	Enabled         *bool           `json:"enabled"`
}

func (in *ruleInput) validate() error {
	if in.Name == "" {
		return fiber.NewError(fiber.StatusBadRequest, "name is required")
	}
	validFields := map[string]bool{"posture_score": true, "battery_level": true}
	if !validFields[in.TriggerField] {
		return fiber.NewError(fiber.StatusBadRequest, "trigger_field must be posture_score or battery_level")
	}
	validOps := map[string]bool{"lt": true, "lte": true, "gt": true, "gte": true, "eq": true}
	if !validOps[in.Operator] {
		return fiber.NewError(fiber.StatusBadRequest, "operator must be lt, lte, gt, gte, or eq")
	}
	if in.Action == "" {
		return fiber.NewError(fiber.StatusBadRequest, "action is required")
	}
	if in.CooldownMinutes <= 0 {
		in.CooldownMinutes = 60
	}
	if in.ActionPayload == nil || !json.Valid(in.ActionPayload) {
		in.ActionPayload = json.RawMessage(`{}`)
	}
	return nil
}

// CreateRule POST /api/v1/compliance/rules
func (h *Handler) CreateRule(c *fiber.Ctx) error {
	tid, err := tenantID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid tenant")
	}
	var in ruleInput
	if err := c.BodyParser(&in); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid body")
	}
	if err := in.validate(); err != nil {
		return err
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	r := &store.Rule{
		TenantID:        tid,
		Name:            in.Name,
		Description:     in.Description,
		TriggerField:    in.TriggerField,
		Operator:        in.Operator,
		Threshold:       in.Threshold,
		Action:          in.Action,
		ActionPayload:   in.ActionPayload,
		CooldownMinutes: in.CooldownMinutes,
		Enabled:         enabled,
		CreatedBy:       userID(c),
	}
	if err := h.store.CreateRule(c.Context(), r); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	return c.Status(fiber.StatusCreated).JSON(r)
}

// UpdateRule PUT /api/v1/compliance/rules/:id
func (h *Handler) UpdateRule(c *fiber.Ctx) error {
	tid, err := tenantID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid tenant")
	}
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid id")
	}
	existing, err := h.store.GetRule(c.Context(), id, tid)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fiber.NewError(fiber.StatusNotFound, "rule not found")
		}
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}

	var in ruleInput
	if err := c.BodyParser(&in); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid body")
	}
	if err := in.validate(); err != nil {
		return err
	}
	enabled := existing.Enabled
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	existing.Name = in.Name
	existing.Description = in.Description
	existing.TriggerField = in.TriggerField
	existing.Operator = in.Operator
	existing.Threshold = in.Threshold
	existing.Action = in.Action
	existing.ActionPayload = in.ActionPayload
	existing.CooldownMinutes = in.CooldownMinutes
	existing.Enabled = enabled

	if err := h.store.UpdateRule(c.Context(), existing); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	return c.JSON(existing)
}

// DeleteRule DELETE /api/v1/compliance/rules/:id
func (h *Handler) DeleteRule(c *fiber.Ctx) error {
	tid, err := tenantID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid tenant")
	}
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid id")
	}
	if err := h.store.DeleteRule(c.Context(), id, tid); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// ─── Events ───────────────────────────────────────────────────────────────────

// ListEvents GET /api/v1/compliance/events?device_id=...&rule_id=...&limit=50
func (h *Handler) ListEvents(c *fiber.Ctx) error {
	tid, err := tenantID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid tenant")
	}
	var deviceID *uuid.UUID
	if raw := c.Query("device_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "invalid device_id")
		}
		deviceID = &id
	}
	var ruleID *uuid.UUID
	if raw := c.Query("rule_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "invalid rule_id")
		}
		ruleID = &id
	}
	limit := c.QueryInt("limit", 100)
	if limit > 500 {
		limit = 500
	}
	events, err := h.store.ListEvents(c.Context(), tid, deviceID, ruleID, limit)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	if events == nil {
		events = []store.Event{}
	}
	return c.JSON(fiber.Map{"events": events})
}

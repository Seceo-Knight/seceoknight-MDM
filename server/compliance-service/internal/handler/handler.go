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

// ─── Geofences ────────────────────────────────────────────────────────────────

type geofenceInput struct {
	Name         string          `json:"name"`
	Description  string          `json:"description"`
	Kind         string          `json:"kind"`
	Coordinates  json.RawMessage `json:"coordinates"`
	CenterLat    float64         `json:"center_lat"`
	CenterLng    float64         `json:"center_lng"`
	RadiusMeters int             `json:"radius_meters"`
	Action       string          `json:"action"`
	Color        string          `json:"color"`
	Enabled      *bool           `json:"enabled"`
}

func (in *geofenceInput) validate() error {
	if in.Name == "" {
		return fiber.NewError(fiber.StatusBadRequest, "name is required")
	}
	if in.Kind == "" {
		in.Kind = "polygon"
	}
	if in.Kind != "polygon" && in.Kind != "circle" {
		return fiber.NewError(fiber.StatusBadRequest, "kind must be polygon or circle")
	}
	if in.Action == "" {
		in.Action = "alert"
	}
	if in.Action != "alert" && in.Action != "lock" && in.Action != "wipe" {
		return fiber.NewError(fiber.StatusBadRequest, "action must be alert, lock, or wipe")
	}
	if in.Color == "" {
		in.Color = "#2DD4E8"
	}
	if in.Coordinates == nil || !json.Valid(in.Coordinates) {
		in.Coordinates = json.RawMessage(`[]`)
	}
	if in.RadiusMeters <= 0 {
		in.RadiusMeters = 500
	}
	return nil
}

// ListGeofences GET /api/v1/compliance/geofences
func (h *Handler) ListGeofences(c *fiber.Ctx) error {
	tid, err := tenantID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid tenant")
	}
	fences, err := h.store.ListGeofences(c.Context(), tid)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	if fences == nil {
		fences = []store.Geofence{}
	}
	return c.JSON(fiber.Map{"geofences": fences})
}

// CreateGeofence POST /api/v1/compliance/geofences
func (h *Handler) CreateGeofence(c *fiber.Ctx) error {
	tid, err := tenantID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid tenant")
	}
	var in geofenceInput
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
	g := &store.Geofence{
		TenantID:     tid,
		Name:         in.Name,
		Description:  in.Description,
		Kind:         in.Kind,
		Coordinates:  in.Coordinates,
		CenterLat:    in.CenterLat,
		CenterLng:    in.CenterLng,
		RadiusMeters: in.RadiusMeters,
		Action:       in.Action,
		Color:        in.Color,
		Enabled:      enabled,
		CreatedBy:    userID(c),
	}
	if err := h.store.CreateGeofence(c.Context(), g); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	return c.Status(fiber.StatusCreated).JSON(g)
}

// UpdateGeofence PUT /api/v1/compliance/geofences/:id
func (h *Handler) UpdateGeofence(c *fiber.Ctx) error {
	tid, err := tenantID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid tenant")
	}
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid id")
	}
	existing, err := h.store.GetGeofence(c.Context(), id, tid)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fiber.NewError(fiber.StatusNotFound, "geofence not found")
		}
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	var in geofenceInput
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
	existing.Kind = in.Kind
	existing.Coordinates = in.Coordinates
	existing.CenterLat = in.CenterLat
	existing.CenterLng = in.CenterLng
	existing.RadiusMeters = in.RadiusMeters
	existing.Action = in.Action
	existing.Color = in.Color
	existing.Enabled = enabled
	if err := h.store.UpdateGeofence(c.Context(), existing); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	return c.JSON(existing)
}

// DeleteGeofence DELETE /api/v1/compliance/geofences/:id
func (h *Handler) DeleteGeofence(c *fiber.Ctx) error {
	tid, err := tenantID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid tenant")
	}
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid id")
	}
	if err := h.store.DeleteGeofence(c.Context(), id, tid); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// ListGeofenceEvents GET /api/v1/compliance/geofences/events
func (h *Handler) ListGeofenceEvents(c *fiber.Ctx) error {
	tid, err := tenantID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid tenant")
	}
	limit := c.QueryInt("limit", 100)
	if limit > 500 {
		limit = 500
	}
	events, err := h.store.ListGeofenceEvents(c.Context(), tid, limit)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	if events == nil {
		events = []store.GeofenceEvent{}
	}
	return c.JSON(fiber.Map{"events": events})
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

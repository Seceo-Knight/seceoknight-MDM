package handlers

import (
	"encoding/json"
	"strconv"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/mdm/audit-service/internal/repository"
	"github.com/mdm/shared/middleware"
	"github.com/mdm/shared/models"
)

type Handler struct{ repo *repository.AuditRepo }

func New(r *repository.AuditRepo) *Handler { return &Handler{repo: r} }

type appendReq struct {
	ActorID    *string         `json:"actor_id,omitempty"`
	ActorKind  string          `json:"actor_kind"`
	Action     string          `json:"action"`
	TargetKind *string         `json:"target_kind,omitempty"`
	TargetID   *string         `json:"target_id,omitempty"`
	Metadata   json.RawMessage `json:"metadata,omitempty"`
}

func (h *Handler) Append(c *fiber.Ctx) error {
	var req appendReq
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed"})
	}
	tenantStr, _ := c.Locals(middleware.CtxTenantID).(string)
	tenantID, _ := uuid.Parse(tenantStr)

	var actor *uuid.UUID
	if req.ActorID != nil {
		a, err := uuid.Parse(*req.ActorID)
		if err == nil {
			actor = &a
		}
	}
	var target *uuid.UUID
	if req.TargetID != nil {
		t, err := uuid.Parse(*req.TargetID)
		if err == nil {
			target = &t
		}
	}

	if req.Metadata == nil {
		req.Metadata = json.RawMessage(`{}`)
	}

	e := &models.AuditEntry{
		TenantID: tenantID, ActorID: actor, ActorKind: req.ActorKind,
		Action: req.Action, TargetKind: req.TargetKind, TargetID: target,
		Metadata: req.Metadata,
	}
	if err := h.repo.Append(c.Context(), e); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.Status(201).JSON(e)
}

func (h *Handler) List(c *fiber.Ctx) error {
	tenantStr, _ := c.Locals(middleware.CtxTenantID).(string)
	tenantID, _ := uuid.Parse(tenantStr)
	limit, _ := strconv.Atoi(c.Query("limit", "100"))
	offset, _ := strconv.Atoi(c.Query("offset", "0"))

	var actor *uuid.UUID
	if s := c.Query("actor_id"); s != "" {
		if a, err := uuid.Parse(s); err == nil {
			actor = &a
		}
	}
	items, err := h.repo.List(c.Context(), repository.ListFilter{
		TenantID: tenantID, Limit: limit, Offset: offset,
		Action: c.Query("action"), ActorID: actor,
	})
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"items": items})
}

package handlers

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/mdm/command-service/internal/service"
	"github.com/mdm/shared/auth"
	"github.com/mdm/shared/authz"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/middleware"
)

type CommandHandler struct{ svc *service.CommandService }

func NewCommandHandler(s *service.CommandService) *CommandHandler { return &CommandHandler{svc: s} }

type createReq struct {
	DeviceID    string          `json:"device_id"`
	Kind        string          `json:"kind"`
	Payload     json.RawMessage `json:"payload,omitempty"`
	MaxAttempts int             `json:"max_attempts,omitempty"`
	TimeoutSec  int             `json:"timeout_sec,omitempty"`
}

func (h *CommandHandler) Create(c *fiber.Ctx) error {
	var req createReq
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed"})
	}
	devID, err := uuid.Parse(req.DeviceID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid device_id"})
	}
	// Per-command-kind authorization: destructive (WIPE/RESET/…) and
	// surveillance (CAPTURE_PHOTO/START_AUDIO_STREAM) commands require strictly
	// more than the basic help-desk tier an operator holds. Enforced here (not
	// just the route's baseline gate) so the risk tier travels with the kind.
	if !authz.Can(roleOf(c), authz.CommandPermission(req.Kind)) {
		return c.Status(403).JSON(fiber.Map{"error": "your role may not issue command " + req.Kind})
	}
	timeout := time.Duration(req.TimeoutSec) * time.Second
	cmd, err := h.svc.Create(c.Context(), service.CreateInput{
		TenantID:    tenantOf(c),
		CreatedBy:   userOf(c),
		DeviceID:    devID,
		Kind:        req.Kind,
		Payload:     req.Payload,
		MaxAttempts: req.MaxAttempts,
		Timeout:     timeout,
	})
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.Status(201).JSON(cmd)
}

type broadcastReq struct {
	GroupID string          `json:"group_id"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Broadcast fans a command out to every device in a group. The per-command-kind
// risk tier is enforced here (same as Create) so, e.g., an operator can message
// a group but not WIPE one.
func (h *CommandHandler) Broadcast(c *fiber.Ctx) error {
	var req broadcastReq
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed"})
	}
	gid, err := uuid.Parse(req.GroupID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid group_id"})
	}
	if !authz.Can(roleOf(c), authz.CommandPermission(req.Kind)) {
		return c.Status(403).JSON(fiber.Map{"error": "your role may not issue command " + req.Kind})
	}
	n, err := h.svc.Broadcast(c.Context(), service.BroadcastInput{
		TenantID:  tenantOf(c),
		CreatedBy: userOf(c),
		GroupID:   gid,
		Kind:      req.Kind,
		Payload:   req.Payload,
	})
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.Status(201).JSON(fiber.Map{"dispatched": n})
}

func (h *CommandHandler) Get(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	cmd, err := h.svc.Get(c.Context(), tenantOf(c), id)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(cmd)
}

func (h *CommandHandler) ListForDevice(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("deviceID"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid device id"})
	}
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	items, err := h.svc.ListForDevice(c.Context(), tenantOf(c), id, limit)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"items": items})
}

// Device-side: poll for pending commands (MQTT fallback).
func (h *CommandHandler) Poll(c *fiber.Ctx) error {
	devStr, _ := c.Locals(middleware.CtxDeviceID).(string)
	devID, err := uuid.Parse(devStr)
	if err != nil {
		return c.Status(401).JSON(fiber.Map{"error": "device required"})
	}
	limit, _ := strconv.Atoi(c.Query("limit", "16"))
	// wait>0 → long-poll: hold the request open until a command arrives or wait
	// elapses. The agent passes wait=20; the Doze tick passes 0 (instant drain).
	wait, _ := strconv.Atoi(c.Query("wait", "0"))
	items, err := h.svc.Poll(c.Context(), devID, limit, wait)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	// Mirror EXACTLY the MQTT dispatcher's published shape (see dispatcher.publish):
	// the agent decodes both paths into the same CommandDto, so the poll body must
	// be {"commands":[{id,kind,payload,timeout_at,issued_at}]}. Returning the raw
	// {"items":[models.Command]} (DB shape, no issued_at) silently fails to decode
	// on the device, so polled commands were received but never executed.
	now := time.Now()
	out := make([]fiber.Map, 0, len(items))
	for _, cmd := range items {
		out = append(out, fiber.Map{
			"id":         cmd.ID,
			"kind":       cmd.Kind,
			"payload":    cmd.Payload,
			"timeout_at": cmd.TimeoutAt,
			"issued_at":  now,
		})
	}
	return c.JSON(fiber.Map{"commands": out})
}

func (h *CommandHandler) Ack(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	if err := h.svc.Ack(c.Context(), id); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(204)
}

func (h *CommandHandler) Result(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	var req service.ResultInput
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed"})
	}
	if err := h.svc.Result(c.Context(), id, req); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
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
func roleOf(c *fiber.Ctx) string {
	claims, _ := c.Locals(middleware.CtxClaims).(*auth.Claims)
	if claims == nil {
		return ""
	}
	return claims.Role
}

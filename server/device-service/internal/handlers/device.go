package handlers

import (
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/mdm/device-service/internal/dto"
	"github.com/mdm/device-service/internal/repository"
	"github.com/mdm/device-service/internal/service"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/middleware"
)

type DeviceHandler struct{ svc *service.DeviceService }

func NewDeviceHandler(s *service.DeviceService) *DeviceHandler { return &DeviceHandler{svc: s} }

func (h *DeviceHandler) List(c *fiber.Ctx) error {
	tenantID := tenantOf(c)
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	offset, _ := strconv.Atoi(c.Query("offset", "0"))
	items, total, err := h.svc.List(c.Context(), repository.ListFilter{
		TenantID: tenantID,
		State:    c.Query("state"),
		Search:   c.Query("q"),
		Limit:    limit,
		Offset:   offset,
	})
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"total": total, "items": items})
}

func (h *DeviceHandler) Get(c *fiber.Ctx) error {
	tenantID := tenantOf(c)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	d, err := h.svc.Get(c.Context(), tenantID, id)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(d)
}

// Update handles admin-side PATCH /devices/:id. Currently the only mutable
// field is the alias (gated to super_admin/admin by the route). The acting
// user is recorded in the audit log.
func (h *DeviceHandler) Update(c *fiber.Ctx) error {
	tenantID := tenantOf(c)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	var req dto.UpdateDeviceRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed"})
	}
	if req.Alias != nil {
		// Trim and treat an emptied field as "clear the alias" (store NULL).
		alias := strings.TrimSpace(*req.Alias)
		var aliasPtr *string
		if alias != "" {
			if len(alias) > 120 {
				alias = alias[:120]
			}
			aliasPtr = &alias
		}
		if err := h.svc.UpdateAlias(c.Context(), tenantID, id, userOf(c), aliasPtr); err != nil {
			return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
		}
	}
	if req.GroupID != nil {
		// Empty string clears membership; otherwise must be a valid group UUID.
		var groupPtr *uuid.UUID
		if s := strings.TrimSpace(*req.GroupID); s != "" {
			g, err := uuid.Parse(s)
			if err != nil {
				return c.Status(400).JSON(fiber.Map{"error": "invalid group_id"})
			}
			groupPtr = &g
		}
		if err := h.svc.SetGroup(c.Context(), tenantID, id, userOf(c), groupPtr); err != nil {
			return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
		}
	}
	d, err := h.svc.Get(c.Context(), tenantID, id)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(d)
}

func (h *DeviceHandler) Retire(c *fiber.Ctx) error {
	tenantID := tenantOf(c)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	if err := h.svc.Retire(c.Context(), tenantID, id, userOf(c)); err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(204)
}

// Posture returns a device's attestation score + factors + compliance verdict.
// This is the conditional-access primitive: an external system (IdP, gateway)
// can poll it to decide whether to grant the device access to a resource.
func (h *DeviceHandler) Posture(c *fiber.Ctx) error {
	tenantID := tenantOf(c)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	d, err := h.svc.Get(c.Context(), tenantID, id)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	compliant := d.LastPostureScore != nil && *d.LastPostureScore >= service.PostureThreshold
	status := "unknown" // no attestation reported yet → fail closed
	if d.LastPostureScore != nil {
		if compliant {
			status = "compliant"
		} else {
			status = "non_compliant"
		}
	}
	return c.JSON(fiber.Map{
		"device_id": id,
		"score":     d.LastPostureScore,
		"factors":   d.LastPostureFactors,
		"threshold": service.PostureThreshold,
		"compliant": compliant,
		"status":    status,
		"at":        d.LastPostureAt,
	})
}

func (h *DeviceHandler) Heartbeat(c *fiber.Ctx) error {
	deviceStr, _ := c.Locals(middleware.CtxDeviceID).(string)
	id, err := uuid.Parse(deviceStr)
	if err != nil {
		return c.Status(401).JSON(fiber.Map{"error": "no device"})
	}
	var req dto.HeartbeatRequest
	_ = c.BodyParser(&req)
	if err := h.svc.Heartbeat(c.Context(), id, req); err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	// 200 + the current debug-unlock hash (was 204) so a password set/rotated
	// after this device enrolled still reaches it. Backward compatible: older
	// agents that expect no body just ignore it.
	return c.JSON(dto.HeartbeatResponse{DebugUnlock: h.svc.DebugUnlockHash(c.Context())})
}

func (h *DeviceHandler) UpdateSelfInfo(c *fiber.Ctx) error {
	deviceStr, _ := c.Locals(middleware.CtxDeviceID).(string)
	id, err := uuid.Parse(deviceStr)
	if err != nil {
		return c.Status(401).JSON(fiber.Map{"error": "no device"})
	}
	var req dto.UpdateDeviceInfoRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed"})
	}
	if err := h.svc.UpdateInfo(c.Context(), id, req); err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(204)
}

// SelfUnenroll lets an enrolled device report — from the agent's Dev Console
// "remove agent" action — that the MDM agent is being removed from it, so the
// server soft-retires the device and the dashboard stops showing it as managed.
// Device-authenticated: the device acts on its OWN row (id + tenant come from
// the device JWT, never the request body). Idempotent and best-effort from the
// agent's side — it's fired just before the app relinquishes admin + uninstalls.
func (h *DeviceHandler) SelfUnenroll(c *fiber.Ctx) error {
	deviceStr, _ := c.Locals(middleware.CtxDeviceID).(string)
	id, err := uuid.Parse(deviceStr)
	if err != nil {
		return c.Status(401).JSON(fiber.Map{"error": "no device"})
	}
	if err := h.svc.SelfUnenroll(c.Context(), tenantOf(c), id); err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(204)
}

func tenantOf(c *fiber.Ctx) uuid.UUID {
	s, _ := c.Locals(middleware.CtxTenantID).(string)
	t, _ := uuid.Parse(s)
	return t
}

// userOf returns the acting admin's user UUID, or uuid.Nil if the request
// wasn't made with a user token (so callers can omit ActorID from audit).
func userOf(c *fiber.Ctx) uuid.UUID {
	s, _ := c.Locals(middleware.CtxUserID).(string)
	u, _ := uuid.Parse(s)
	return u
}

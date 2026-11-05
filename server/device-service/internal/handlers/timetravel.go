package handlers

import (
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/mdm/device-service/internal/repository"
)

type TimeTravelHandler struct{ repo *repository.TimeTravelRepo }

func NewTimeTravelHandler(r *repository.TimeTravelRepo) *TimeTravelHandler {
	return &TimeTravelHandler{repo: r}
}

// parseTime reads an RFC3339 query param, falling back to def.
func parseTime(c *fiber.Ctx, key string, def time.Time) time.Time {
	s := c.Query(key)
	if s == "" {
		return def
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return def
	}
	return t
}

// Fleet reconstructs the whole fleet's state at a given instant (?at=RFC3339,
// default now) plus the "who did what" audit feed up to that instant.
func (h *TimeTravelHandler) Fleet(c *fiber.Ctx) error {
	tenantID := tenantOf(c)
	at := parseTime(c, "at", time.Now())
	devices, err := h.repo.FleetAsOf(c.Context(), tenantID, at)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	actions, err := h.repo.AuditUpTo(c.Context(), tenantID, at, 100)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"at": at, "devices": devices, "actions": actions})
}

// Device returns a single device's snapshot series and audit timeline within a
// window (?from=&to=RFC3339, default last 24h) — for location scrub + history.
func (h *TimeTravelHandler) Device(c *fiber.Ctx) error {
	tenantID := tenantOf(c)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	to := parseTime(c, "to", time.Now())
	from := parseTime(c, "from", to.Add(-24*time.Hour))
	series, err := h.repo.DeviceSeries(c.Context(), tenantID, id, from, to)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	actions, err := h.repo.AuditForDevice(c.Context(), tenantID, id, from, to, 200)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"from": from, "to": to, "snapshots": series, "actions": actions})
}

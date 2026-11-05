package handlers

import (
	"encoding/json"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/mdm/shared/middleware"
	"github.com/mdm/shared/models"
	"github.com/mdm/telemetry-service/internal/repository"
)

type Handler struct{ repo *repository.TelemetryRepo }

func New(r *repository.TelemetryRepo) *Handler { return &Handler{repo: r} }

type ingestReq struct {
	Events []struct {
		Kind       string          `json:"kind"`
		Payload    json.RawMessage `json:"payload"`
		CapturedAt time.Time       `json:"captured_at"`
	} `json:"events"`
}

// Device-side: batched ingest. Up to 500 events per call.
func (h *Handler) Ingest(c *fiber.Ctx) error {
	var req ingestReq
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed"})
	}
	if len(req.Events) == 0 {
		return c.SendStatus(204)
	}
	if len(req.Events) > 500 {
		return c.Status(400).JSON(fiber.Map{"error": "batch too large"})
	}
	devStr, _ := c.Locals(middleware.CtxDeviceID).(string)
	tenantStr, _ := c.Locals(middleware.CtxTenantID).(string)
	devID, _ := uuid.Parse(devStr)
	tenantID, _ := uuid.Parse(tenantStr)

	now := time.Now()
	evs := make([]models.TelemetryEvent, 0, len(req.Events))
	for _, e := range req.Events {
		if e.Kind == "" || !json.Valid(e.Payload) {
			continue
		}
		captured := e.CapturedAt
		if captured.IsZero() {
			captured = now
		}
		evs = append(evs, models.TelemetryEvent{
			TenantID: tenantID, DeviceID: devID, Kind: e.Kind,
			Payload: e.Payload, CapturedAt: captured, ReceivedAt: now,
		})
	}
	if err := h.repo.Ingest(c.Context(), evs); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(202)
}

// Admin-side: latest snapshot for a device, keyed by kind.
func (h *Handler) Latest(c *fiber.Ctx) error {
	tenantStr, _ := c.Locals(middleware.CtxTenantID).(string)
	tenantID, _ := uuid.Parse(tenantStr)
	devID, err := uuid.Parse(c.Params("deviceID"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid device id"})
	}
	m, err := h.repo.Latest(c.Context(), tenantID, devID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(m)
}

// Events returns the reverse-chronological event stream for a device.
//   GET /api/v1/telemetry/devices/:deviceID/events?limit=200&kind_prefix=activity.
// Used by the admin UI's Activity tab.
func (h *Handler) Events(c *fiber.Ctx) error {
	tenantStr, _ := c.Locals(middleware.CtxTenantID).(string)
	tenantID, _ := uuid.Parse(tenantStr)
	devID, err := uuid.Parse(c.Params("deviceID"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid device id"})
	}
	limit := c.QueryInt("limit", 200)
	prefix := c.Query("kind_prefix")
	items, err := h.repo.List(c.Context(), tenantID, devID, limit, prefix)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"items": items})
}

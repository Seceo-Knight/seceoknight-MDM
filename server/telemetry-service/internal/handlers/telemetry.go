package handlers

import (
	"encoding/json"
	"sort"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/mdm/shared/middleware"
	"github.com/mdm/shared/models"
	"github.com/mdm/telemetry-service/internal/anomaly"
	"github.com/mdm/telemetry-service/internal/repository"
)

type Handler struct {
	repo         *repository.TelemetryRepo
	anomalyStore *anomaly.Store
}

func New(r *repository.TelemetryRepo, as *anomaly.Store) *Handler {
	return &Handler{repo: r, anomalyStore: as}
}

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

// ─── Anomaly endpoints ────────────────────────────────────────────────────────

// ListAnomalies returns all unresolved anomalies for the tenant.
//   GET /api/v1/telemetry/anomalies?limit=200
func (h *Handler) ListAnomalies(c *fiber.Ctx) error {
	tenantStr, _ := c.Locals(middleware.CtxTenantID).(string)
	tenantID, _ := uuid.Parse(tenantStr)
	limit := c.QueryInt("limit", 200)
	items, err := h.anomalyStore.ListAnomalies(c.Context(), tenantID, limit)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"items": items})
}

// ListDeviceAnomalies returns anomalies for a specific device.
//   GET /api/v1/telemetry/devices/:deviceID/anomalies?limit=100
func (h *Handler) ListDeviceAnomalies(c *fiber.Ctx) error {
	tenantStr, _ := c.Locals(middleware.CtxTenantID).(string)
	tenantID, _ := uuid.Parse(tenantStr)
	devID, err := uuid.Parse(c.Params("deviceID"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid device id"})
	}
	limit := c.QueryInt("limit", 100)
	items, err := h.anomalyStore.ListDeviceAnomalies(c.Context(), tenantID, devID, limit)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"items": items})
}

// FleetApps aggregates app_inventory telemetry across all devices for a tenant.
// Returns a list of {package_name, app_name, version_name, device_count, device_ids}
// sorted by device_count descending.
//   GET /api/v1/telemetry/fleet/apps?limit=500
func (h *Handler) FleetApps(c *fiber.Ctx) error {
	tenantStr, _ := c.Locals(middleware.CtxTenantID).(string)
	tenantID, _ := uuid.Parse(tenantStr)
	limit := c.QueryInt("limit", 500)
	if limit > 2000 {
		limit = 2000
	}

	// Pull latest app_inventory snapshot for every device in this tenant.
	rows, err := h.repo.DB().QueryContext(c.Context(), `
		SELECT device_id, payload
		  FROM device_telemetry_latest
		 WHERE tenant_id = $1 AND kind = 'app_inventory'`, tenantID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	defer rows.Close()

	type appEntry struct {
		PackageName string `json:"package_name"`
		AppName     string `json:"app_name"`
		VersionName string `json:"version_name,omitempty"`
	}
	type inventoryPayload struct {
		Apps []appEntry `json:"apps"`
	}

	type appStat struct {
		PackageName string   `json:"package_name"`
		AppName     string   `json:"app_name"`
		VersionName string   `json:"version_name,omitempty"`
		DeviceCount int      `json:"device_count"`
		DeviceIDs   []string `json:"device_ids"`
	}
	statsMap := map[string]*appStat{}

	for rows.Next() {
		var devID uuid.UUID
		var payload json.RawMessage
		if err := rows.Scan(&devID, &payload); err != nil {
			continue
		}
		var inv inventoryPayload
		if err := json.Unmarshal(payload, &inv); err != nil {
			continue
		}
		for _, app := range inv.Apps {
			if app.PackageName == "" {
				continue
			}
			s, ok := statsMap[app.PackageName]
			if !ok {
				s = &appStat{
					PackageName: app.PackageName,
					AppName:     app.AppName,
					VersionName: app.VersionName,
				}
				statsMap[app.PackageName] = s
			}
			s.DeviceCount++
			s.DeviceIDs = append(s.DeviceIDs, devID.String())
		}
	}
	if err := rows.Err(); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}

	// Convert map to sorted slice.
	stats := make([]*appStat, 0, len(statsMap))
	for _, s := range statsMap {
		stats = append(stats, s)
	}
	// Sort by device_count desc, then package_name asc.
	sort.Slice(stats, func(i, j int) bool {
		if stats[i].DeviceCount != stats[j].DeviceCount {
			return stats[i].DeviceCount > stats[j].DeviceCount
		}
		return stats[i].PackageName < stats[j].PackageName
	})
	if len(stats) > limit {
		stats = stats[:limit]
	}
	return c.JSON(fiber.Map{"items": stats, "total": len(statsMap)})
}

// ResolveAnomaly marks an anomaly as resolved.
//   POST /api/v1/telemetry/anomalies/:id/resolve
func (h *Handler) ResolveAnomaly(c *fiber.Ctx) error {
	tenantStr, _ := c.Locals(middleware.CtxTenantID).(string)
	tenantID, _ := uuid.Parse(tenantStr)
	anomalyID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid anomaly id"})
	}
	if err := h.anomalyStore.ResolveAnomaly(c.Context(), tenantID, anomalyID); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(204)
}

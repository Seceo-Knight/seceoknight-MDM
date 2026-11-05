// Package handler provides HTTP handlers for the alert-service API.
package handler

import (
	"context"
	"database/sql"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/lib/pq"

	"github.com/mdm/alert-service/internal/sender"
	"github.com/mdm/alert-service/internal/store"
	"github.com/mdm/shared/auth"
)

type Handler struct {
	store *store.Store
}

func New(s *store.Store) *Handler { return &Handler{store: s} }

// tenantFromCtx extracts the tenant UUID from the JWT claims set by middleware.
func tenantFromCtx(c *fiber.Ctx) (uuid.UUID, error) {
	claims, ok := c.Locals("claims").(*auth.Claims)
	if !ok || claims == nil {
		return uuid.Nil, fiber.ErrUnauthorized
	}
	return uuid.Parse(claims.TenantID)
}

func userIDFromCtx(c *fiber.Ctx) *uuid.UUID {
	claims, ok := c.Locals("claims").(*auth.Claims)
	if !ok || claims == nil {
		return nil
	}
	uid, err := uuid.Parse(claims.Subject)
	if err != nil {
		return nil
	}
	return &uid
}

// ─── Channel CRUD ─────────────────────────────────────────────────────────────

// ListChannels GET /api/v1/alerts/channels
func (h *Handler) ListChannels(c *fiber.Ctx) error {
	tenantID, err := tenantFromCtx(c)
	if err != nil {
		return err
	}
	channels, err := h.store.ListChannels(c.Context(), tenantID)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	// Mask sensitive fields
	for i := range channels {
		if channels[i].SMTPPass != "" {
			channels[i].SMTPPass = "••••••••"
		}
		if channels[i].WebhookSecret != "" {
			channels[i].WebhookSecret = "••••••••"
		}
	}
	return c.JSON(fiber.Map{"channels": channels})
}

// GetChannel GET /api/v1/alerts/channels/:id
func (h *Handler) GetChannel(c *fiber.Ctx) error {
	tenantID, err := tenantFromCtx(c)
	if err != nil {
		return err
	}
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid id")
	}
	ch, err := h.store.GetChannel(c.Context(), id, tenantID)
	if err == store.ErrNotFound || err == sql.ErrNoRows {
		return fiber.ErrNotFound
	}
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	ch.SMTPPass = ""
	ch.WebhookSecret = ""
	return c.JSON(ch)
}

type channelBody struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	// Email
	SMTPHost string   `json:"smtp_host"`
	SMTPPort int      `json:"smtp_port"`
	SMTPTLS  bool     `json:"smtp_tls"`
	SMTPUser string   `json:"smtp_user"`
	SMTPPass string   `json:"smtp_pass"`
	SMTPFrom string   `json:"smtp_from"`
	SMTPTo   []string `json:"smtp_to"`
	// Webhook
	WebhookURL    string `json:"webhook_url"`
	WebhookSecret string `json:"webhook_secret"`
	// Subscriptions
	OnComplianceTrigger bool `json:"on_compliance_trigger"`
	OnDeviceOffline     bool `json:"on_device_offline"`
	OnPostureDrop       bool `json:"on_posture_drop"`
	Enabled             bool `json:"enabled"`
}

// CreateChannel POST /api/v1/alerts/channels
func (h *Handler) CreateChannel(c *fiber.Ctx) error {
	tenantID, err := tenantFromCtx(c)
	if err != nil {
		return err
	}
	var body channelBody
	if err = c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	if body.Name == "" || (body.Kind != "email" && body.Kind != "webhook") {
		return fiber.NewError(fiber.StatusBadRequest, "name and kind (email|webhook) are required")
	}
	if body.SMTPPort == 0 {
		body.SMTPPort = 587
	}
	uid := userIDFromCtx(c)
	ch := &store.Channel{
		TenantID:            tenantID,
		Name:                body.Name,
		Kind:                body.Kind,
		SMTPHost:            body.SMTPHost,
		SMTPPort:            body.SMTPPort,
		SMTPTLS:             body.SMTPTLS,
		SMTPUser:            body.SMTPUser,
		SMTPPass:            body.SMTPPass,
		SMTPFrom:            body.SMTPFrom,
		SMTPTo:              pq.StringArray(body.SMTPTo),
		WebhookURL:          body.WebhookURL,
		WebhookSecret:       body.WebhookSecret,
		OnComplianceTrigger: body.OnComplianceTrigger,
		OnDeviceOffline:     body.OnDeviceOffline,
		OnPostureDrop:       body.OnPostureDrop,
		Enabled:             body.Enabled,
		CreatedBy:           uid,
	}
	if err = h.store.CreateChannel(c.Context(), ch); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	ch.SMTPPass = ""
	ch.WebhookSecret = ""
	return c.Status(fiber.StatusCreated).JSON(ch)
}

// UpdateChannel PUT /api/v1/alerts/channels/:id
func (h *Handler) UpdateChannel(c *fiber.Ctx) error {
	tenantID, err := tenantFromCtx(c)
	if err != nil {
		return err
	}
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid id")
	}
	// Fetch existing so we can keep the secret if the client sends "••••"
	existing, err := h.store.GetChannel(c.Context(), id, tenantID)
	if err == store.ErrNotFound || err == sql.ErrNoRows {
		return fiber.ErrNotFound
	}
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}

	var body channelBody
	if err = c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	if body.SMTPPort == 0 {
		body.SMTPPort = 587
	}

	// Don't overwrite secrets if client sent masked placeholder
	smtpPass := body.SMTPPass
	if smtpPass == "••••••••" || smtpPass == "" {
		smtpPass = existing.SMTPPass
	}
	webhookSecret := body.WebhookSecret
	if webhookSecret == "••••••••" || webhookSecret == "" {
		webhookSecret = existing.WebhookSecret
	}

	ch := &store.Channel{
		ID:                  id,
		TenantID:            tenantID,
		Name:                body.Name,
		Kind:                body.Kind,
		SMTPHost:            body.SMTPHost,
		SMTPPort:            body.SMTPPort,
		SMTPTLS:             body.SMTPTLS,
		SMTPUser:            body.SMTPUser,
		SMTPPass:            smtpPass,
		SMTPFrom:            body.SMTPFrom,
		SMTPTo:              pq.StringArray(body.SMTPTo),
		WebhookURL:          body.WebhookURL,
		WebhookSecret:       webhookSecret,
		OnComplianceTrigger: body.OnComplianceTrigger,
		OnDeviceOffline:     body.OnDeviceOffline,
		OnPostureDrop:       body.OnPostureDrop,
		Enabled:             body.Enabled,
	}
	if err = h.store.UpdateChannel(c.Context(), ch); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	ch.SMTPPass = ""
	ch.WebhookSecret = ""
	return c.JSON(ch)
}

// DeleteChannel DELETE /api/v1/alerts/channels/:id
func (h *Handler) DeleteChannel(c *fiber.Ctx) error {
	tenantID, err := tenantFromCtx(c)
	if err != nil {
		return err
	}
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid id")
	}
	if err = h.store.DeleteChannel(c.Context(), id, tenantID); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// ─── Test-send ────────────────────────────────────────────────────────────────

// TestChannel POST /api/v1/alerts/channels/:id/test
// Sends a "test" alert to verify the channel is configured correctly.
func (h *Handler) TestChannel(c *fiber.Ctx) error {
	tenantID, err := tenantFromCtx(c)
	if err != nil {
		return err
	}
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid id")
	}
	ch, err := h.store.GetChannel(c.Context(), id, tenantID)
	if err == store.ErrNotFound || err == sql.ErrNoRows {
		return fiber.ErrNotFound
	}
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}

	p := sender.AlertPayload{
		EventType: "test",
		Subject:   "Test Alert from SeceoKnight MDM",
		TenantID:  tenantID.String(),
		Data: map[string]any{
			"message": "This is a test alert. If you received this, the channel is working correctly.",
		},
		Timestamp: time.Now().UTC(),
	}
	// Use a background context so the HTTP response isn't tied to delivery time.
	go sender.DeliverAll(context.Background(), h.store, []store.Channel{*ch}, p)
	return c.JSON(fiber.Map{"status": "queued", "message": "Test alert is being delivered."})
}

// ─── Delivery Log ─────────────────────────────────────────────────────────────

// ListLog GET /api/v1/alerts/log
func (h *Handler) ListLog(c *fiber.Ctx) error {
	tenantID, err := tenantFromCtx(c)
	if err != nil {
		return err
	}
	var channelID *uuid.UUID
	if cidStr := c.Query("channel_id"); cidStr != "" {
		cid, err := uuid.Parse(cidStr)
		if err == nil {
			channelID = &cid
		}
	}
	entries, err := h.store.ListLog(c.Context(), tenantID, channelID, 200)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	return c.JSON(fiber.Map{"logs": entries})
}

// ─── Internal notify endpoint ─────────────────────────────────────────────────

// NotifyRequest is the body for the internal /internal/notify route,
// called by compliance-service (or any internal service) to fan out an alert.
type NotifyRequest struct {
	TenantID  string         `json:"tenant_id"`
	EventType string         `json:"event_type"`
	Subject   string         `json:"subject"`
	Data      map[string]any `json:"data"`
}

// Notify POST /internal/notify  (no auth — called service-to-service inside Docker network)
func (h *Handler) Notify(c *fiber.Ctx) error {
	var req NotifyRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	tenantID, err := uuid.Parse(req.TenantID)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid tenant_id")
	}
	channels, err := h.store.EnabledChannelsForEvent(c.Context(), tenantID, req.EventType)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}
	if len(channels) == 0 {
		return c.JSON(fiber.Map{"dispatched": 0})
	}
	p := sender.AlertPayload{
		EventType: req.EventType,
		Subject:   req.Subject,
		TenantID:  req.TenantID,
		Data:      req.Data,
		Timestamp: time.Now().UTC(),
	}
	go sender.DeliverAll(context.Background(), h.store, channels, p)
	return c.JSON(fiber.Map{"dispatched": len(channels)})
}

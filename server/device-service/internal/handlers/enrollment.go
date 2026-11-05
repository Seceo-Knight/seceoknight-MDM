package handlers

import (
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/mdm/device-service/internal/dto"
	"github.com/mdm/device-service/internal/service"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/middleware"
)

type EnrollmentHandler struct{ svc *service.EnrollmentService }

func NewEnrollmentHandler(s *service.EnrollmentService) *EnrollmentHandler {
	return &EnrollmentHandler{svc: s}
}

func (h *EnrollmentHandler) CreateToken(c *fiber.Ctx) error {
	var req dto.CreateEnrollmentTokenRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed body"})
	}
	tenantStr, _ := c.Locals(middleware.CtxTenantID).(string)
	tenantID, _ := uuid.Parse(tenantStr)
	userStr, _ := c.Locals(middleware.CtxUserID).(string)
	userID, _ := uuid.Parse(userStr)

	ttl, _ := time.ParseDuration(req.ExpiresIn)
	var policyID *uuid.UUID
	if req.PolicyID != nil {
		p, err := uuid.Parse(*req.PolicyID)
		if err == nil {
			policyID = &p
		}
	}
	resp, err := h.svc.CreateToken(c.Context(), service.CreateTokenInput{
		TenantID: tenantID, CreatedBy: userID, PolicyID: policyID,
		OneShot: req.OneShot, MaxUses: req.MaxUses, TTL: ttl,
		ProvisioningMode: req.ProvisioningMode,
	})
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.Status(201).JSON(resp)
}

func (h *EnrollmentHandler) QRPayload(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("tokenID"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid token id"})
	}
	payload, err := h.svc.BuildQRPayload(c.Context(), id)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(payload)
}

func (h *EnrollmentHandler) GetConfig(c *fiber.Ctx) error {
	tenantStr, _ := c.Locals(middleware.CtxTenantID).(string)
	tenantID, _ := uuid.Parse(tenantStr)
	cfg, err := h.svc.GetConfig(c.Context(), tenantID)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(cfg)
}

func (h *EnrollmentHandler) SaveConfig(c *fiber.Ctx) error {
	var req dto.EnrollmentConfigDTO
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed body"})
	}
	tenantStr, _ := c.Locals(middleware.CtxTenantID).(string)
	tenantID, _ := uuid.Parse(tenantStr)
	userStr, _ := c.Locals(middleware.CtxUserID).(string)
	userID, _ := uuid.Parse(userStr)
	cfg, err := h.svc.SaveConfig(c.Context(), tenantID, userID, req)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(cfg)
}

func (h *EnrollmentHandler) GetPlatformSettings(c *fiber.Ctx) error {
	ps, err := h.svc.GetPlatformSettings(c.Context())
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(ps)
}

func (h *EnrollmentHandler) SavePlatformSettings(c *fiber.Ctx) error {
	var req dto.PlatformSettingsDTO
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed body"})
	}
	userStr, _ := c.Locals(middleware.CtxUserID).(string)
	userID, _ := uuid.Parse(userStr)
	ps, err := h.svc.SavePlatformSettings(c.Context(), userID, req)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(ps)
}

func (h *EnrollmentHandler) Enroll(c *fiber.Ctx) error {
	var req dto.EnrollRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed body"})
	}
	resp, err := h.svc.Enroll(c.Context(), req)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.Status(201).JSON(resp)
}

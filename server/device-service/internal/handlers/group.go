package handlers

import (
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/mdm/device-service/internal/dto"
	"github.com/mdm/device-service/internal/service"
	apperr "github.com/mdm/shared/errors"
)

type GroupHandler struct{ svc *service.GroupService }

func NewGroupHandler(s *service.GroupService) *GroupHandler { return &GroupHandler{svc: s} }

func (h *GroupHandler) List(c *fiber.Ctx) error {
	items, err := h.svc.List(c.Context(), tenantOf(c))
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"items": items})
}

func (h *GroupHandler) Create(c *fiber.Ctx) error {
	var req dto.CreateGroupRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed"})
	}
	g, err := h.svc.Create(c.Context(), tenantOf(c), userOf(c), req)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.Status(201).JSON(g)
}

func (h *GroupHandler) Update(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	var req dto.UpdateGroupRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed"})
	}
	if err := h.svc.Update(c.Context(), tenantOf(c), userOf(c), id, req); err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(204)
}

func (h *GroupHandler) Delete(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	if err := h.svc.Delete(c.Context(), tenantOf(c), userOf(c), id); err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(204)
}

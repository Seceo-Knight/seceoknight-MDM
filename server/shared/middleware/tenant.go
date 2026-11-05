package middleware

import (
	"github.com/gofiber/fiber/v2"
	"github.com/mdm/shared/auth"
)

// TenantScope sets a database session variable so downstream queries can rely
// on row-level security and ensures the tenant claim is non-empty.
func TenantScope() fiber.Handler {
	return func(c *fiber.Ctx) error {
		claims, _ := c.Locals(CtxClaims).(*auth.Claims)
		if claims == nil || claims.TenantID == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "missing tenant"})
		}
		c.Locals(CtxTenantID, claims.TenantID)
		return c.Next()
	}
}

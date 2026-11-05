package middleware

import (
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

// RequestLogger emits one structured log line per request and tags it with a
// request ID exposed in the X-Request-ID header so it can be correlated across
// services.
func RequestLogger() fiber.Handler {
	return func(c *fiber.Ctx) error {
		start := time.Now()
		rid := c.Get("X-Request-ID")
		if rid == "" {
			rid = uuid.NewString()
		}
		c.Set("X-Request-ID", rid)
		c.Locals("rid", rid)

		err := c.Next()

		evt := log.Info()
		if err != nil || c.Response().StatusCode() >= 500 {
			evt = log.Error()
		}
		evt.
			Str("rid", rid).
			Str("method", c.Method()).
			Str("path", c.Path()).
			Int("status", c.Response().StatusCode()).
			Dur("dur", time.Since(start)).
			Str("ip", c.IP()).
			Msg("http")
		return err
	}
}

// Recover converts panics into 500 responses and logs them.
func Recover() fiber.Handler {
	return func(c *fiber.Ctx) (err error) {
		defer func() {
			if r := recover(); r != nil {
				log.Error().Interface("panic", r).Msg("recovered from panic")
				err = c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
			}
		}()
		return c.Next()
	}
}

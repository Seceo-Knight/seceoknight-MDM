// Package middleware provides HTTP middlewares used across services.
package middleware

import (
	"context"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/mdm/shared/auth"
	"github.com/mdm/shared/authz"
)

// Session-revocation denylist. When a session is force-logged-out, auth-service
// writes "revoked_session:<sid>" to Redis; every service's JWTAuth checks it so
// a revoked session's still-valid access token is rejected on its NEXT request
// (instant force-logout) instead of lingering until the token expires. The
// client is lazily built from REDIS_ADDR — no per-service wiring needed — and
// the check FAILS OPEN so a Redis blip can never lock the whole fleet out.
var (
	revokeOnce sync.Once
	revokeRDB  *redis.Client
)

func revokeClient() *redis.Client {
	revokeOnce.Do(func() {
		if addr := os.Getenv("REDIS_ADDR"); addr != "" {
			revokeRDB = redis.NewClient(&redis.Options{Addr: addr})
		}
	})
	return revokeRDB
}

func sessionRevoked(ctx context.Context, sid string) bool {
	rc := revokeClient()
	if rc == nil {
		return false
	}
	cctx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	n, err := rc.Exists(cctx, "revoked_session:"+sid).Result()
	return err == nil && n > 0 // fail open on error
}

const (
	CtxClaims   = "claims"
	CtxTenantID = "tenantID"
	CtxUserID   = "userID"
	CtxDeviceID = "deviceID"
)

// JWTAuth verifies the bearer token using the supplied issuer and rejects
// requests with missing or invalid tokens. The verified Claims are placed in
// fiber locals under CtxClaims.
func JWTAuth(issuer *auth.Issuer) fiber.Handler {
	return func(c *fiber.Ctx) error {
		h := c.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			// Logged so a "device rejected" report can be traced to the real
			// cause (here: the client sent no bearer token at all).
			log.Warn().Str("path", c.Path()).Str("ip", c.IP()).Msg("auth: missing bearer token")
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "missing bearer token"})
		}
		raw := strings.TrimPrefix(h, "Bearer ")
		claims, err := issuer.Parse(raw)
		if err != nil {
			// Surface the EXACT reason (expired vs bad signature vs malformed) so
			// an IP-change "rejected this device" can be diagnosed from the logs
			// instead of guessed at — a 401 here is a token problem, not a refresh
			// problem.
			log.Warn().Err(err).Str("path", c.Path()).Str("ip", c.IP()).Msg("auth: token rejected")
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid token"})
		}
		// Instant force-logout: reject a token whose session has been revoked.
		if claims.SID != "" && sessionRevoked(c.Context(), claims.SID) {
			log.Warn().Str("sid", claims.SID).Str("path", c.Path()).Msg("auth: session revoked")
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "session revoked"})
		}
		c.Locals(CtxClaims, claims)
		c.Locals(CtxTenantID, claims.TenantID)
		if claims.Kind == auth.KindUser {
			c.Locals(CtxUserID, claims.Subject)
		} else {
			c.Locals(CtxDeviceID, claims.Subject)
		}
		return c.Next()
	}
}

// RequireRole enforces RBAC for admin-side endpoints.
func RequireRole(roles ...string) fiber.Handler {
	allowed := make(map[string]struct{}, len(roles))
	for _, r := range roles {
		allowed[r] = struct{}{}
	}
	return func(c *fiber.Ctx) error {
		claims, _ := c.Locals(CtxClaims).(*auth.Claims)
		if claims == nil || claims.Kind != auth.KindUser {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "user token required"})
		}
		if _, ok := allowed[claims.Role]; !ok {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "insufficient role"})
		}
		return c.Next()
	}
}

// RequirePermission enforces the RBAC permission matrix (shared/authz). The
// caller must present a user token whose role grants AT LEAST ONE of the given
// permissions. This is the preferred guard for all admin-side routes — it keeps
// the role→capability mapping in one place instead of scattering role lists
// across services. Denials are logged for forensics and fail closed.
func RequirePermission(perms ...authz.Permission) fiber.Handler {
	return func(c *fiber.Ctx) error {
		claims, _ := c.Locals(CtxClaims).(*auth.Claims)
		if claims == nil || claims.Kind != auth.KindUser {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "user token required"})
		}
		for _, p := range perms {
			if authz.Can(claims.Role, p) {
				return c.Next()
			}
		}
		log.Warn().
			Str("role", claims.Role).
			Str("subject", claims.Subject).
			Str("method", c.Method()).
			Str("path", c.Path()).
			Interface("required", perms).
			Msg("authz: permission denied")
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "insufficient permissions"})
	}
}

// RequirePermissionOrDevice allows EITHER a device token OR a user token that
// holds one of the permissions. Use it for endpoints a device legitimately
// needs but which are otherwise admin-only — e.g. presigning the download of
// its own self-update APK (GET /files/:id/url). TenantScope still confines a
// device to its own tenant's objects, and the device only ever learns an object
// id the server handed it (in the INSTALL_APP command), so this isn't a
// browse-all-files grant.
func RequirePermissionOrDevice(perms ...authz.Permission) fiber.Handler {
	return func(c *fiber.Ctx) error {
		claims, _ := c.Locals(CtxClaims).(*auth.Claims)
		if claims == nil {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "token required"})
		}
		if claims.Kind == auth.KindDevice {
			return c.Next()
		}
		for _, p := range perms {
			if authz.Can(claims.Role, p) {
				return c.Next()
			}
		}
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "insufficient permissions"})
	}
}

// RequireDevice ensures the caller is a device token.
func RequireDevice() fiber.Handler {
	return func(c *fiber.Ctx) error {
		claims, _ := c.Locals(CtxClaims).(*auth.Claims)
		if claims == nil || claims.Kind != auth.KindDevice {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "device token required"})
		}
		return c.Next()
	}
}

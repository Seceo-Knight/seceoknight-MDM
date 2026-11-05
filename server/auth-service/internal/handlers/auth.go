package handlers

import (
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/mdm/auth-service/internal/dto"
	"github.com/mdm/auth-service/internal/service"
	"github.com/mdm/shared/auth"
	"github.com/mdm/shared/authz"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/middleware"
)

// permStrings returns the permission strings a role holds (for API responses).
func permStrings(role string) []string {
	perms := authz.PermissionsFor(role)
	out := make([]string, len(perms))
	for i, p := range perms {
		out[i] = string(p)
	}
	return out
}

type AuthHandler struct{ svc *service.AuthService }

func NewAuthHandler(s *service.AuthService) *AuthHandler { return &AuthHandler{svc: s} }

func (h *AuthHandler) Login(c *fiber.Ctx) error {
	var req dto.LoginRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed body"})
	}
	if req.Email == "" || req.Password == "" {
		return c.Status(400).JSON(fiber.Map{"error": "email and password required"})
	}

	pair, err := h.svc.Login(c.Context(), service.LoginInput{
		Email:     req.Email,
		Password:  req.Password,
		UserAgent: c.Get("User-Agent"),
		IP:        clientIP(c),
	})
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}

	resp := dto.LoginResponse{
		AccessToken:  pair.Access,
		RefreshToken: pair.Refresh,
		ExpiresIn:    int((15 * 60)), // mirror JWT_ACCESS_TTL default
		TokenType:    "Bearer",
	}
	resp.User.ID = pair.User.ID.String()
	resp.User.Email = pair.User.Email
	resp.User.Role = string(pair.User.Role)
	resp.User.TenantID = pair.User.TenantID.String()
	resp.User.Permissions = permStrings(string(pair.User.Role))
	return c.JSON(resp)
}

func (h *AuthHandler) Refresh(c *fiber.Ctx) error {
	var req dto.RefreshRequest
	if err := c.BodyParser(&req); err != nil || req.RefreshToken == "" {
		return c.Status(400).JSON(fiber.Map{"error": "refresh_token required"})
	}
	pair, err := h.svc.Refresh(c.Context(), req.RefreshToken, c.Get("User-Agent"), clientIP(c))
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(dto.RefreshResponse{
		AccessToken:  pair.Access,
		RefreshToken: pair.Refresh,
		ExpiresIn:    15 * 60,
		TokenType:    "Bearer",
	})
}

func (h *AuthHandler) Logout(c *fiber.Ctx) error {
	var req dto.RefreshRequest
	_ = c.BodyParser(&req)
	if req.RefreshToken != "" {
		_ = h.svc.Logout(c.Context(), req.RefreshToken)
	}
	return c.SendStatus(204)
}

// Users lists the tenant's admin users (id/email/role) so the dashboard can
// resolve audit-log actor UUIDs to a readable email. Gated to super_admin/admin
// by the route. Tenant is taken from the caller's JWT claims.
func (h *AuthHandler) Users(c *fiber.Ctx) error {
	tenantStr, _ := c.Locals(middleware.CtxTenantID).(string)
	tenantID, err := uuid.Parse(tenantStr)
	if err != nil {
		return c.Status(401).JSON(fiber.Map{"error": "no tenant"})
	}
	users, err := h.svc.ListUsers(c.Context(), tenantID)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	items := make([]dto.MeResponse, 0, len(users))
	for _, u := range users {
		items = append(items, dto.MeResponse{
			ID:       u.ID.String(),
			Email:    u.Email,
			Role:     string(u.Role),
			TenantID: u.TenantID.String(),
		})
	}
	return c.JSON(fiber.Map{"items": items})
}

// Sessions lists the tenant's active admin sessions for the Access Log
// (user:read). Each row is a live login: who, since when, from which IP/agent.
func (h *AuthHandler) Sessions(c *fiber.Ctx) error {
	rows, err := h.svc.ListSessions(c.Context(), tenantOf(c))
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	items := make([]dto.SessionDTO, 0, len(rows))
	for _, r := range rows {
		ip, ua := "", ""
		if r.IPAddr != nil {
			ip = *r.IPAddr
		}
		if r.UserAgent != nil {
			ua = *r.UserAgent
		}
		items = append(items, dto.SessionDTO{
			ID:        r.ID.String(),
			UserID:    r.UserID.String(),
			Email:     r.Email,
			Role:      r.Role,
			IP:        ip,
			UserAgent: ua,
			IssuedAt:  r.IssuedAt.UTC().Format(time.RFC3339),
			ExpiresAt: r.ExpiresAt.UTC().Format(time.RFC3339),
		})
	}
	return c.JSON(fiber.Map{"items": items})
}

// RevokeSession force-logs-out a session (user:manage).
func (h *AuthHandler) RevokeSession(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	if err := h.svc.RevokeSession(c.Context(), tenantOf(c), userOf(c), id); err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(204)
}

// ChangePassword updates the logged-in user's own password (verifies current).
func (h *AuthHandler) ChangePassword(c *fiber.Ctx) error {
	uidStr, _ := c.Locals(middleware.CtxUserID).(string)
	id, err := uuid.Parse(uidStr)
	if err != nil {
		return c.Status(401).JSON(fiber.Map{"error": "no user"})
	}
	var req dto.ChangePasswordRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed"})
	}
	if err := h.svc.ChangePassword(c.Context(), id, req.OldPassword, req.NewPassword); err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(204)
}

// UpdateProfile updates the logged-in user's own profile (currently email).
func (h *AuthHandler) UpdateProfile(c *fiber.Ctx) error {
	uidStr, _ := c.Locals(middleware.CtxUserID).(string)
	id, err := uuid.Parse(uidStr)
	if err != nil {
		return c.Status(401).JSON(fiber.Map{"error": "no user"})
	}
	var req dto.UpdateProfileRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed"})
	}
	if req.Email == nil {
		return c.Status(400).JSON(fiber.Map{"error": "nothing to update"})
	}
	u, err := h.svc.UpdateEmail(c.Context(), id, *req.Email)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(dto.MeResponse{
		ID: u.ID.String(), Email: u.Email, Role: string(u.Role), TenantID: u.TenantID.String(),
	})
}

func (h *AuthHandler) Me(c *fiber.Ctx) error {
	uidStr, _ := c.Locals(middleware.CtxUserID).(string)
	id, err := uuid.Parse(uidStr)
	if err != nil {
		return c.Status(401).JSON(fiber.Map{"error": "no user"})
	}
	u, err := h.svc.Me(c.Context(), id)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(dto.MeResponse{
		ID:          u.ID.String(),
		Email:       u.Email,
		Role:        string(u.Role),
		TenantID:    u.TenantID.String(),
		Permissions: permStrings(string(u.Role)),
	})
}

// Roles returns the full RBAC matrix (roles, all permissions, role→permissions)
// for the admin UI's Roles & Access page.
func (h *AuthHandler) Roles(c *fiber.Ctx) error {
	all := authz.AllPermissions()
	perms := make([]string, len(all))
	for i, p := range all {
		perms[i] = string(p)
	}
	matrix := map[string][]string{}
	for _, r := range authz.Roles() {
		matrix[r] = permStrings(r)
	}
	return c.JSON(dto.RolesResponse{Roles: authz.Roles(), Permissions: perms, Matrix: matrix})
}

// CreateUser provisions a new admin user (user:manage / super_admin).
func (h *AuthHandler) CreateUser(c *fiber.Ctx) error {
	var req dto.CreateUserRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed"})
	}
	u, err := h.svc.CreateUser(c.Context(), tenantOf(c), userOf(c), roleOf(c), req.Email, req.Password, req.Role)
	if err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.Status(201).JSON(dto.MeResponse{
		ID: u.ID.String(), Email: u.Email, Role: string(u.Role), TenantID: u.TenantID.String(),
	})
}

// UpdateUserRole changes a user's role (user:manage / super_admin).
func (h *AuthHandler) UpdateUserRole(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	var req dto.UpdateRoleRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "malformed"})
	}
	if err := h.svc.UpdateUserRole(c.Context(), tenantOf(c), userOf(c), roleOf(c), id, req.Role); err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(204)
}

// DeactivateUser soft-deletes a user (user:manage / super_admin).
func (h *AuthHandler) DeactivateUser(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	if err := h.svc.DeactivateUser(c.Context(), tenantOf(c), userOf(c), roleOf(c), id); err != nil {
		return c.Status(apperr.HTTPStatus(err)).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(204)
}

// clientIP returns the ORIGINAL client address. c.IP() (with the trusted-proxy
// X-Forwarded-For config) can hand back the whole "client, proxy1, proxy2"
// chain, so take the leftmost entry — that's the real caller.
func clientIP(c *fiber.Ctx) string {
	ip := c.IP()
	if i := strings.IndexByte(ip, ','); i >= 0 {
		ip = ip[:i]
	}
	return strings.TrimSpace(ip)
}

func tenantOf(c *fiber.Ctx) uuid.UUID {
	s, _ := c.Locals(middleware.CtxTenantID).(string)
	t, _ := uuid.Parse(s)
	return t
}
func userOf(c *fiber.Ctx) uuid.UUID {
	s, _ := c.Locals(middleware.CtxUserID).(string)
	u, _ := uuid.Parse(s)
	return u
}
func roleOf(c *fiber.Ctx) string {
	claims, _ := c.Locals(middleware.CtxClaims).(*auth.Claims)
	if claims == nil {
		return ""
	}
	return claims.Role
}

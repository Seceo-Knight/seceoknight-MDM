// Package service holds the auth use cases: login, refresh, logout, identity.
// The handler layer is a thin adapter to HTTP; business logic lives here.
package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/pquerna/otp/totp"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
	qrcode "github.com/skip2/go-qrcode"

	"github.com/mdm/auth-service/internal/repository"
	"github.com/mdm/shared/auth"
	"github.com/mdm/shared/authz"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/events"
	"github.com/mdm/shared/models"
	"github.com/mdm/shared/mq"
)

type AuthService struct {
	users      *repository.UserRepo
	refresh    *repository.RefreshRepo
	issuer     *auth.Issuer
	refreshTTL time.Duration
	bus        *mq.Bus
	redis      *redis.Client // session-revocation denylist (nil = feature off)
}

func NewAuthService(u *repository.UserRepo, r *repository.RefreshRepo, iss *auth.Issuer, refreshTTL time.Duration, bus *mq.Bus, rdb *redis.Client) *AuthService {
	return &AuthService{users: u, refresh: r, issuer: iss, refreshTTL: refreshTTL, bus: bus, redis: rdb}
}

// sessionDenyTTL is how long a force-revoked session id stays on the Redis
// denylist. Comfortably longer than any access-token TTL, after which the token
// is expired anyway and the entry is moot.
const sessionDenyTTL = 2 * time.Hour

type LoginInput struct {
	Email     string
	Password  string
	MFACode   string
	UserAgent string
	IP        string
}

// ErrMFARequired is a sentinel returned by Login when the user has MFA enabled
// but no TOTP code was supplied. The handler maps this to a 200 with
// {"mfa_required": true} so the client can show the TOTP challenge screen.
var ErrMFARequired = errors.New("mfa_required")

type TokenPair struct {
	Access  string
	Refresh string
	User    *models.User
}

func (s *AuthService) Login(ctx context.Context, in LoginInput) (*TokenPair, error) {
	u, err := s.users.FindByEmail(ctx, in.Email)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, apperr.New(apperr.CodeUnauthorized, "invalid credentials")
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "user lookup", err)
	}
	if !auth.VerifyPassword(u.PasswordHash, in.Password) {
		// Failed login on a REAL account (wrong password) — audit it for the
		// Access Log / brute-force forensics. Unknown-email attempts aren't
		// audited (no tenant/actor to attribute them to).
		s.auditUser(ctx, u.TenantID, u.ID, "user.login_failed", u.ID, map[string]any{
			"email": u.Email, "ip": in.IP, "user_agent": in.UserAgent,
		})
		return nil, apperr.New(apperr.CodeUnauthorized, "invalid credentials")
	}

	// ---- MFA enforcement ------------------------------------------------
	if u.MFAEnabled {
		if in.MFACode == "" {
			// Step 1: password correct, MFA required — tell the client to ask
			// for the TOTP code. This is NOT an auth failure.
			return nil, ErrMFARequired
		}
		mfaData, err := s.users.GetMFAData(ctx, u.ID)
		if err != nil {
			return nil, apperr.Wrap(apperr.CodeInternal, "mfa data lookup", err)
		}
		if mfaData.MFASecret == nil {
			return nil, apperr.New(apperr.CodeInternal, "mfa secret missing")
		}
		// Try TOTP first, then fall back to backup code.
		valid := totp.Validate(in.MFACode, *mfaData.MFASecret)
		if !valid {
			// Try backup codes (8-char uppercase alphanumeric).
			hashed := hashBackupCode(in.MFACode)
			if err := s.users.ConsumeBackupCode(ctx, u.ID, hashed); err != nil {
				s.auditUser(ctx, u.TenantID, u.ID, "user.mfa_failed", u.ID, map[string]any{
					"email": u.Email, "ip": in.IP,
				})
				return nil, apperr.New(apperr.CodeUnauthorized, "invalid MFA code")
			}
			// Backup code consumed successfully.
			s.auditUser(ctx, u.TenantID, u.ID, "user.mfa_backup_used", u.ID, map[string]any{
				"email": u.Email, "ip": in.IP,
			})
		}
	}
	// ---- end MFA --------------------------------------------------------

	// The session id (sid) embedded in the access token is the refresh token's
	// own id, so a later force-logout of this session can reject the access
	// token instantly. Generate it before issuing the access token.
	rtID := uuid.New()
	access, err := s.issuer.IssueUser(u.ID, u.TenantID, string(u.Role), rtID.String())
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "issue access", err)
	}
	plain, hash, err := auth.NewRefreshToken()
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "issue refresh", err)
	}

	now := time.Now()
	if err := s.refresh.Insert(ctx, &models.RefreshToken{
		ID:        rtID,
		TenantID:  u.TenantID,
		SubjectID: u.ID,
		Kind:      "user",
		TokenHash: hash,
		IssuedAt:  now,
		ExpiresAt: now.Add(s.refreshTTL),
		UserAgent: ptr(in.UserAgent),
		IPAddr:    ptr(in.IP),
	}); err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "persist refresh", err)
	}
	if err := s.users.TouchLogin(ctx, u.ID); err != nil {
		log.Warn().Err(err).Msg("touch login")
	}
	// Successful login → Access Log entry (who / when / from where).
	s.auditUser(ctx, u.TenantID, u.ID, "user.login", u.ID, map[string]any{
		"email": u.Email, "ip": in.IP, "user_agent": in.UserAgent,
	})

	return &TokenPair{Access: access, Refresh: plain, User: u}, nil
}

// Refresh implements rotation. If a presented token was already revoked, the
// whole chain is invalidated (theft heuristic).
func (s *AuthService) Refresh(ctx context.Context, plain, userAgent, ip string) (*TokenPair, error) {
	hash := auth.HashRefresh(plain)
	tok, err := s.refresh.FindActive(ctx, hash)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, apperr.New(apperr.CodeUnauthorized, "invalid refresh token")
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "find refresh", err)
	}
	if tok.RevokedAt != nil {
		// A revoked token was presented. This is EITHER token theft (replay of a
		// genuinely old token) OR a benign "lost rotation response": the device
		// rotated this token, but never received the successor — e.g. the server
		// was restarted for a LAN IP change mid-refresh — so on repoint it retries
		// with the only token it still holds. Re-enrolling every device after an
		// IP change traces back to here.
		//
		// We tell the two apart structurally, without relying on timing: if this
		// token's immediate successor is STILL ACTIVE (never consumed, unexpired),
		// the legitimate next token was never used by anyone, so the replay is the
		// lost-response case — we recover the device by rolling the chain forward
		// from that unconsumed successor. If the successor is missing, expired, or
		// itself already revoked, the chain advanced past this token, which is the
		// real reuse signal → revoke the whole chain.
		//
		// Tradeoff: this relaxes strict reuse-detection. We scope recovery to
		// DEVICE tokens only (see recoverLostRotation), where the refresh token is
		// sealed in Android Keystore-backed storage (low theft risk) and the cost
		// of a false positive is a painful full re-enrollment. User/browser
		// sessions keep strict detection — a re-login is cheap, and browser tokens
		// are the higher-risk theft target.
		if pair, err := s.recoverLostRotation(ctx, tok, userAgent, ip); err != nil {
			return nil, err
		} else if pair != nil {
			log.Info().Str("token_id", tok.ID.String()).Msg("recovered lost token rotation (no re-enroll needed)")
			return pair, nil
		}
		_ = s.refresh.RevokeChain(ctx, tok.ID)
		log.Warn().Str("token_id", tok.ID.String()).Msg("revoked-token replay detected")
		return nil, apperr.New(apperr.CodeUnauthorized, "refresh token revoked")
	}
	if time.Now().After(tok.ExpiresAt) {
		return nil, apperr.New(apperr.CodeUnauthorized, "refresh token expired")
	}

	// Rotate first so the new refresh token's id can be embedded as the access
	// token's session id (sid) — keeping force-logout able to target it.
	newPlain, newID, err := s.rotateForward(ctx, tok, userAgent, ip)
	if err != nil {
		return nil, err
	}
	access, user, err := s.issueAccessFor(ctx, tok, newID.String())
	if err != nil {
		return nil, err
	}
	return &TokenPair{Access: access, Refresh: newPlain, User: user}, nil
}

// ListSessions returns the tenant's ACTIVE admin sessions (one row per live user
// refresh token) for the Access Log — who is signed in, since when, from which
// IP / user-agent.
func (s *AuthService) ListSessions(ctx context.Context, tenantID uuid.UUID) ([]repository.SessionRow, error) {
	return s.refresh.ListUserSessions(ctx, tenantID)
}

// RevokeSession force-logs-out a session by revoking its whole token chain.
// Scoped to the caller's tenant and to user sessions only.
func (s *AuthService) RevokeSession(ctx context.Context, tenantID, actorID, tokenID uuid.UUID) error {
	tok, err := s.refresh.FindByID(ctx, tokenID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return apperr.New(apperr.CodeNotFound, "session not found")
		}
		return apperr.Wrap(apperr.CodeInternal, "find session", err)
	}
	if tok.TenantID != tenantID || tok.Kind != "user" {
		return apperr.New(apperr.CodeNotFound, "session not found")
	}
	if err := s.refresh.RevokeChain(ctx, tokenID); err != nil {
		return apperr.Wrap(apperr.CodeInternal, "revoke session", err)
	}
	s.denySession(ctx, tokenID) // instant: reject the live access token (sid == this id)
	s.auditUser(ctx, tenantID, actorID, "user.session_revoked", tok.SubjectID, nil)
	return nil
}

// denySession adds a session id to the Redis denylist so every service's auth
// middleware rejects its access token on the next request (instant force-logout).
func (s *AuthService) denySession(ctx context.Context, sid uuid.UUID) {
	if s.redis == nil {
		return
	}
	if err := s.redis.Set(ctx, "revoked_session:"+sid.String(), "1", sessionDenyTTL).Err(); err != nil {
		log.Warn().Err(err).Msg("session denylist write failed")
	}
}

// recoverLostRotation handles the "lost rotation response" case described in
// Refresh. It returns (pair, nil) when it recovered the chain, (nil, nil) when
// the replay looks like genuine reuse and the caller should revoke, or
// (nil, err) on a real error.
func (s *AuthService) recoverLostRotation(ctx context.Context, presented *models.RefreshToken, userAgent, ip string) (*TokenPair, error) {
	if presented.Kind != "device" {
		return nil, nil // strict reuse-detection for user/browser sessions
	}
	if presented.ReplacedBy == nil {
		return nil, nil // no successor recorded → cannot safely recover
	}
	succ, err := s.refresh.FindByID(ctx, *presented.ReplacedBy)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, nil
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "find successor", err)
	}
	// The successor must be unconsumed and unexpired for this to be a benign
	// lost-response retry rather than a chain that has genuinely advanced.
	if succ.RevokedAt != nil || time.Now().After(succ.ExpiresAt) {
		return nil, nil
	}
	access, user, err := s.issueAccessFor(ctx, succ, "") // device tokens carry no session id
	if err != nil {
		return nil, err
	}
	newPlain, newHash, err := auth.NewRefreshToken()
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "issue refresh", err)
	}
	now := time.Now()
	newRT := &models.RefreshToken{
		ID:        uuid.New(),
		TenantID:  succ.TenantID,
		SubjectID: succ.SubjectID,
		Kind:      succ.Kind,
		TokenHash: newHash,
		IssuedAt:  now,
		ExpiresAt: now.Add(s.refreshTTL),
		UserAgent: ptr(userAgent),
		IPAddr:    ptr(ip),
	}
	if err := s.refresh.Insert(ctx, newRT); err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "persist refresh", err)
	}
	// Conditional rotate: if a concurrent retry already rolled the successor
	// forward, bail to the safe (revoke) path rather than double-spending.
	ok, err := s.refresh.RotateIfActive(ctx, succ.ID, newRT.ID)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "rotate successor", err)
	}
	if !ok {
		return nil, nil
	}
	return &TokenPair{Access: access, Refresh: newPlain, User: user}, nil
}

// issueAccessFor mints an access token of the same kind as the given refresh
// token, returning the populated user for the "user" kind.
func (s *AuthService) issueAccessFor(ctx context.Context, tok *models.RefreshToken, sid string) (string, *models.User, error) {
	switch tok.Kind {
	case "user":
		u, err := s.users.FindByID(ctx, tok.SubjectID)
		if err != nil {
			return "", nil, apperr.Wrap(apperr.CodeInternal, "find user", err)
		}
		access, err := s.issuer.IssueUser(u.ID, u.TenantID, string(u.Role), sid)
		if err != nil {
			return "", nil, apperr.Wrap(apperr.CodeInternal, "issue user access", err)
		}
		return access, u, nil
	case "device":
		access, err := s.issuer.IssueDevice(tok.SubjectID, tok.TenantID)
		if err != nil {
			return "", nil, apperr.Wrap(apperr.CodeInternal, "issue device access", err)
		}
		return access, nil, nil
	default:
		return "", nil, apperr.New(apperr.CodeForbidden, "unknown token kind: "+tok.Kind)
	}
}

// rotateForward mints a new refresh token for the same subject and revokes the
// presented one, linking the two. Returns the new plaintext refresh token.
func (s *AuthService) rotateForward(ctx context.Context, tok *models.RefreshToken, userAgent, ip string) (string, uuid.UUID, error) {
	newPlain, newHash, err := auth.NewRefreshToken()
	if err != nil {
		return "", uuid.Nil, apperr.Wrap(apperr.CodeInternal, "issue refresh", err)
	}
	now := time.Now()
	newRT := &models.RefreshToken{
		ID:        uuid.New(),
		TenantID:  tok.TenantID,
		SubjectID: tok.SubjectID,
		Kind:      tok.Kind,
		TokenHash: newHash,
		IssuedAt:  now,
		ExpiresAt: now.Add(s.refreshTTL),
		UserAgent: ptr(userAgent),
		IPAddr:    ptr(ip),
	}
	if err := s.refresh.Insert(ctx, newRT); err != nil {
		return "", uuid.Nil, apperr.Wrap(apperr.CodeInternal, "persist refresh", err)
	}
	if err := s.refresh.Rotate(ctx, tok.ID, newRT.ID); err != nil {
		log.Warn().Err(err).Msg("rotate refresh failed")
	}
	return newPlain, newRT.ID, nil
}

func (s *AuthService) Logout(ctx context.Context, plain string) error {
	tok, err := s.refresh.FindActive(ctx, auth.HashRefresh(plain))
	if err != nil {
		// Idempotent: missing token is success.
		return nil
	}
	s.denySession(ctx, tok.ID) // make explicit logout take effect immediately too
	return s.refresh.Revoke(ctx, tok.ID)
}

func (s *AuthService) Me(ctx context.Context, userID uuid.UUID) (*models.User, error) {
	return s.users.FindByID(ctx, userID)
}

func (s *AuthService) ListUsers(ctx context.Context, tenantID uuid.UUID) ([]models.User, error) {
	return s.users.ListByTenant(ctx, tenantID)
}

// CreateUser provisions a new admin user. The route gates this to user:manage
// (admin + super_admin); the actorRole hierarchy check below stops an admin
// from minting a user more privileged than themselves.
func (s *AuthService) CreateUser(ctx context.Context, tenantID, actorID uuid.UUID, actorRole, email, password, role string) (*models.User, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	if !strings.Contains(email, "@") {
		return nil, apperr.New(apperr.CodeInvalidInput, "a valid email is required")
	}
	if len(password) < 8 {
		return nil, apperr.New(apperr.CodeInvalidInput, "password must be at least 8 characters")
	}
	if !authz.ValidRole(role) {
		return nil, apperr.New(apperr.CodeInvalidInput, "unknown role")
	}
	if !authz.CanManageRole(actorRole, role) {
		return nil, apperr.New(apperr.CodeForbidden, "you cannot create a user with a role above your own")
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "hash password", err)
	}
	u := &models.User{ID: uuid.New(), TenantID: tenantID, Email: email, PasswordHash: hash, Role: models.Role(role)}
	if err := s.users.CreateUser(ctx, u); err != nil {
		if errors.Is(err, repository.ErrEmailTaken) {
			return nil, apperr.New(apperr.CodeConflict, "that email is already in use")
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "create user", err)
	}
	s.auditUser(ctx, tenantID, actorID, "user.created", u.ID, map[string]any{"email": email, "role": role})
	return u, nil
}

// UpdateUserRole changes a user's role. Guards against self-demotion and
// removing the tenant's last super_admin (both would risk a lockout).
func (s *AuthService) UpdateUserRole(ctx context.Context, tenantID, actorID uuid.UUID, actorRole string, targetID uuid.UUID, role string) error {
	if !authz.ValidRole(role) {
		return apperr.New(apperr.CodeInvalidInput, "unknown role")
	}
	target, err := s.users.FindByID(ctx, targetID)
	if err != nil {
		return apperr.New(apperr.CodeNotFound, "user not found")
	}
	if target.TenantID != tenantID {
		return apperr.New(apperr.CodeNotFound, "user not found")
	}
	// No escalation: can't modify a user above your rank, can't assign above it.
	if !authz.CanManageRole(actorRole, string(target.Role)) {
		return apperr.New(apperr.CodeForbidden, "you cannot modify a user with a higher role than your own")
	}
	if !authz.CanManageRole(actorRole, role) {
		return apperr.New(apperr.CodeForbidden, "you cannot assign a role above your own")
	}
	if targetID == actorID && role != authz.RoleSuperAdmin {
		return apperr.New(apperr.CodeInvalidInput, "you cannot remove your own super_admin role")
	}
	if string(target.Role) == authz.RoleSuperAdmin && role != authz.RoleSuperAdmin {
		n, _ := s.users.CountActiveSuperAdmins(ctx, tenantID)
		if n <= 1 {
			return apperr.New(apperr.CodeInvalidInput, "cannot demote the last super_admin")
		}
	}
	if err := s.users.UpdateRole(ctx, tenantID, targetID, role); err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return apperr.New(apperr.CodeNotFound, "user not found")
		}
		return apperr.Wrap(apperr.CodeInternal, "update role", err)
	}
	s.auditUser(ctx, tenantID, actorID, "user.role_changed", targetID, map[string]any{"role": role})
	return nil
}

// DeactivateUser soft-deletes a user. Guards self-deactivation and last super_admin.
func (s *AuthService) DeactivateUser(ctx context.Context, tenantID, actorID uuid.UUID, actorRole string, targetID uuid.UUID) error {
	if targetID == actorID {
		return apperr.New(apperr.CodeInvalidInput, "you cannot deactivate your own account")
	}
	target, err := s.users.FindByID(ctx, targetID)
	if err != nil || target.TenantID != tenantID {
		return apperr.New(apperr.CodeNotFound, "user not found")
	}
	if !authz.CanManageRole(actorRole, string(target.Role)) {
		return apperr.New(apperr.CodeForbidden, "you cannot deactivate a user with a higher role than your own")
	}
	if string(target.Role) == authz.RoleSuperAdmin {
		n, _ := s.users.CountActiveSuperAdmins(ctx, tenantID)
		if n <= 1 {
			return apperr.New(apperr.CodeInvalidInput, "cannot deactivate the last super_admin")
		}
	}
	if err := s.users.Deactivate(ctx, tenantID, targetID); err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return apperr.New(apperr.CodeNotFound, "user not found")
		}
		return apperr.Wrap(apperr.CodeInternal, "deactivate user", err)
	}
	s.auditUser(ctx, tenantID, actorID, "user.deactivated", targetID, nil)
	return nil
}

func (s *AuthService) auditUser(ctx context.Context, tenantID, actorID uuid.UUID, action string, targetID uuid.UUID, meta map[string]any) {
	var metaJSON []byte
	if meta != nil {
		metaJSON, _ = json.Marshal(meta)
	}
	events.Emit(ctx, s.bus, events.AuditEnvelope{
		TenantID:   tenantID.String(),
		ActorID:    events.UUIDStrPtr(actorID),
		ActorKind:  "user",
		Action:     action,
		TargetKind: events.StrPtr("user"),
		TargetID:   events.UUIDStrPtr(targetID),
		Metadata:   metaJSON,
	})
}

// ChangePassword verifies the user's current password before setting a new one.
func (s *AuthService) ChangePassword(ctx context.Context, userID uuid.UUID, oldPw, newPw string) error {
	if len(newPw) < 8 {
		return apperr.New(apperr.CodeInvalidInput, "new password must be at least 8 characters")
	}
	u, err := s.users.FindByID(ctx, userID)
	if err != nil {
		return apperr.Wrap(apperr.CodeInternal, "find user", err)
	}
	if !auth.VerifyPassword(u.PasswordHash, oldPw) {
		return apperr.New(apperr.CodeUnauthorized, "current password is incorrect")
	}
	hash, err := auth.HashPassword(newPw)
	if err != nil {
		return apperr.Wrap(apperr.CodeInternal, "hash password", err)
	}
	if err := s.users.UpdatePasswordHash(ctx, userID, hash); err != nil {
		return apperr.Wrap(apperr.CodeInternal, "update password", err)
	}
	return nil
}

// UpdateEmail changes the logged-in user's email (must be unique in tenant).
func (s *AuthService) UpdateEmail(ctx context.Context, userID uuid.UUID, email string) (*models.User, error) {
	email = strings.TrimSpace(email)
	if !strings.Contains(email, "@") || len(email) < 3 {
		return nil, apperr.New(apperr.CodeInvalidInput, "a valid email is required")
	}
	if err := s.users.UpdateEmail(ctx, userID, email); err != nil {
		if errors.Is(err, repository.ErrEmailTaken) {
			return nil, apperr.New(apperr.CodeConflict, "that email is already in use")
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "update email", err)
	}
	return s.users.FindByID(ctx, userID)
}

func ptr[T any](v T) *T { return &v }

// ---- MFA service methods -------------------------------------------------

// MFASetupResult carries the QR code data-URI and the raw secret for the
// setup screen. MFA is NOT yet enabled — the user must confirm with ConfirmMFA.
type MFASetupResult struct {
	Secret string
	QRCode string // "data:image/png;base64,..." data-URI
}

// SetupMFA generates a fresh TOTP secret for the user and returns the QR code.
// It does NOT activate MFA — the caller must call ConfirmMFA with a valid TOTP
// code to prove the authenticator app is wired up correctly.
func (s *AuthService) SetupMFA(ctx context.Context, userID uuid.UUID) (*MFASetupResult, error) {
	u, err := s.users.FindByID(ctx, userID)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "find user", err)
	}
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      "SeceoKnight MDM",
		AccountName: u.Email,
	})
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "generate totp key", err)
	}
	// Persist the pending secret (mfa_enabled stays false until ConfirmMFA).
	if err := s.users.StoreMFASecret(ctx, userID, key.Secret()); err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "store mfa secret", err)
	}
	// Render the QR code server-side as a base64 PNG data-URI so the frontend
	// can display it as a plain <img> without needing a client-side QR library.
	png, err := qrcode.Encode(key.URL(), qrcode.Medium, 256)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "render qr code", err)
	}
	qrDataURI := "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	return &MFASetupResult{Secret: key.Secret(), QRCode: qrDataURI}, nil
}

// ConfirmMFA verifies the user's TOTP code, then activates MFA and returns 8
// single-use backup codes (plain-text — only shown once).
func (s *AuthService) ConfirmMFA(ctx context.Context, userID uuid.UUID, code string) ([]string, error) {
	mfaData, err := s.users.GetMFAData(ctx, userID)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "get mfa data", err)
	}
	if mfaData.MFASecret == nil {
		return nil, apperr.New(apperr.CodeInvalidInput, "MFA setup not initiated — call /mfa/setup first")
	}
	if !totp.Validate(code, *mfaData.MFASecret) {
		return nil, apperr.New(apperr.CodeUnauthorized, "invalid TOTP code")
	}
	plain, hashed := generateBackupCodes(8)
	if err := s.users.EnableMFA(ctx, userID, *mfaData.MFASecret, hashed); err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "enable mfa", err)
	}
	u, _ := s.users.FindByID(ctx, userID)
	if u != nil {
		s.auditUser(ctx, u.TenantID, userID, "user.mfa_enabled", userID, nil)
	}
	return plain, nil
}

// DisableMFA requires a valid TOTP code or backup code to prevent accidental
// or unauthorised disablement.
func (s *AuthService) DisableMFA(ctx context.Context, userID uuid.UUID, code string) error {
	mfaData, err := s.users.GetMFAData(ctx, userID)
	if err != nil {
		return apperr.Wrap(apperr.CodeInternal, "get mfa data", err)
	}
	if !mfaData.MFAEnabled {
		return apperr.New(apperr.CodeInvalidInput, "MFA is not enabled")
	}
	// Verify TOTP first; fall back to backup code.
	valid := mfaData.MFASecret != nil && totp.Validate(code, *mfaData.MFASecret)
	if !valid {
		hashed := hashBackupCode(code)
		if cerr := s.users.ConsumeBackupCode(ctx, userID, hashed); cerr != nil {
			return apperr.New(apperr.CodeUnauthorized, "invalid TOTP or backup code")
		}
	}
	if err := s.users.DisableMFA(ctx, userID); err != nil {
		return apperr.Wrap(apperr.CodeInternal, "disable mfa", err)
	}
	u, _ := s.users.FindByID(ctx, userID)
	if u != nil {
		s.auditUser(ctx, u.TenantID, userID, "user.mfa_disabled", userID, nil)
	}
	return nil
}

// RegenerateBackupCodes replaces all backup codes. Requires a live TOTP code.
func (s *AuthService) RegenerateBackupCodes(ctx context.Context, userID uuid.UUID, totpCode string) ([]string, error) {
	mfaData, err := s.users.GetMFAData(ctx, userID)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "get mfa data", err)
	}
	if !mfaData.MFAEnabled {
		return nil, apperr.New(apperr.CodeInvalidInput, "MFA is not enabled")
	}
	if mfaData.MFASecret == nil || !totp.Validate(totpCode, *mfaData.MFASecret) {
		return nil, apperr.New(apperr.CodeUnauthorized, "invalid TOTP code")
	}
	plain, hashed := generateBackupCodes(8)
	if err := s.users.SetBackupCodes(ctx, userID, hashed); err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "set backup codes", err)
	}
	return plain, nil
}

// MFAStatus returns whether MFA is currently enabled for a user.
func (s *AuthService) MFAStatus(ctx context.Context, userID uuid.UUID) (bool, error) {
	mfaData, err := s.users.GetMFAData(ctx, userID)
	if err != nil {
		return false, apperr.Wrap(apperr.CodeInternal, "get mfa data", err)
	}
	return mfaData.MFAEnabled, nil
}

// ---- MFA helpers ---------------------------------------------------------

// generateBackupCodes creates n random 8-char uppercase alphanumeric codes and
// returns two parallel slices: plain-text (to show to user once) and their
// SHA-256 hex hashes (to store in DB).
func generateBackupCodes(n int) (plain []string, hashed []string) {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // omit I/O/0/1 (visually ambiguous)
	buf := make([]byte, 1)
	for i := 0; i < n; i++ {
		code := make([]byte, 8)
		for j := range code {
			_, _ = rand.Read(buf)
			code[j] = chars[int(buf[0])%len(chars)]
		}
		p := string(code)
		plain = append(plain, p)
		hashed = append(hashed, hashBackupCode(p))
	}
	return
}

// hashBackupCode returns the lower-hex SHA-256 of the uppercased, trimmed code.
func hashBackupCode(code string) string {
	h := sha256.Sum256([]byte(strings.ToUpper(strings.TrimSpace(code))))
	return fmt.Sprintf("%x", h)
}

package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/google/uuid"

	"github.com/mdm/device-service/internal/dto"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/events"
	"github.com/mdm/shared/models"
)

// debugUnlockSalt is a fixed, app-wide salt prefix. It is NOT secret (it ships
// in the agent APK too) — its only job is to domain-separate the hash. The
// agent computes the identical sha256(debugUnlockSalt + password) so it can
// verify the operator's typed password locally/offline. MUST stay byte-for-byte
// in sync with the agent's DebugUnlock.SALT.
const debugUnlockSalt = "cybersentinel:debug-unlock:v1:"

// DebugUnlockHash returns the hex sha256 of the salted password, or "" when no
// password is configured (which disables the agent's debug panel). Shared by
// the enroll-time and heartbeat-time delivery paths.
func DebugUnlockHash(pw string) string {
	if pw == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(debugUnlockSalt + pw))
	return hex.EncodeToString(sum[:])
}

// GetPlatformSettings returns the global settings row (debug-unlock password in
// plaintext, for the operator to view/rotate in the admin UI).
func (s *EnrollmentService) GetPlatformSettings(ctx context.Context) (*models.PlatformSettings, error) {
	ps, err := s.tokens.GetPlatformSettings(ctx)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "load platform settings", err)
	}
	return ps, nil
}

// SavePlatformSettings persists the global debug-unlock password and audits it.
func (s *EnrollmentService) SavePlatformSettings(ctx context.Context, userID uuid.UUID, in dto.PlatformSettingsDTO) (*models.PlatformSettings, error) {
	pw := strings.TrimSpace(in.DebugUnlockPassword)
	if err := s.tokens.UpsertPlatformSettings(ctx, pw, userID); err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "save platform settings", err)
	}
	events.Emit(ctx, s.bus, events.AuditEnvelope{
		ActorKind: "user",
		ActorID:   events.UUIDStrPtr(userID),
		Action:    "platform.settings.updated",
	})
	return s.GetPlatformSettings(ctx)
}

// DebugUnlockHash returns the hash the agent caches for offline password
// verification, read fresh from the global settings (heartbeat delivery path).
func (s *DeviceService) DebugUnlockHash(ctx context.Context) string {
	pw, err := s.devices.PlatformDebugPassword(ctx)
	if err != nil {
		return ""
	}
	return DebugUnlockHash(pw)
}

// Package service holds the enrollment + device use cases.
//
// Enrollment flow:
//   1. Admin POST /api/v1/enroll/tokens — returns an enrollment token id+token.
//   2. Admin renders a QR (the JSON payload at /api/v1/enroll/qr/:tokenID).
//   3. Factory-reset Android device scans QR. Setup Wizard downloads the DPC
//      from PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION and sets it as
//      Device Owner; the DPC reads PROVISIONING_ADMIN_EXTRAS_BUNDLE which
//      contains the enrollment token + server URL.
//   4. DPC calls POST /api/v1/enroll → server creates the Device row and
//      returns access + refresh tokens, MQTT credentials, and bootstrapping
//      info.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/nats-io/nats.go"

	"github.com/mdm/device-service/internal/dto"
	"github.com/mdm/device-service/internal/repository"
	"github.com/mdm/shared/auth"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/events"
	"github.com/mdm/shared/models"
	"github.com/mdm/shared/mq"
)

const (
	// DPCSignatureChecksum is the urlsafe-base64 SHA-256 of the agent APK's
	// signing certificate. Replace with your real signing cert's checksum.
	// Computed via: `keytool -list -printcert -file CERT.RSA` then SHA-256 of
	// the DER, base64 URL-encoded (Android requires the URL-safe variant).
	DPCSignatureChecksum = "REPLACE_WITH_AGENT_APK_SIGNING_CERT_SHA256_URLSAFE_B64"

	DPCPackageName = "com.mdm.agent"
	DPCComponent   = "com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver"
)

type EnrollmentService struct {
	devices       *repository.DeviceRepo
	tokens        *repository.EnrollmentRepo
	db            *sqlx.DB
	issuer        *auth.Issuer
	bus           *mq.Bus
	publicBaseURL string
	refreshTTL    time.Duration
}

func NewEnrollmentService(d *repository.DeviceRepo, t *repository.EnrollmentRepo, db *sqlx.DB, iss *auth.Issuer, bus *mq.Bus, baseURL string, refreshTTL time.Duration) *EnrollmentService {
	return &EnrollmentService{
		devices: d, tokens: t, db: db,
		issuer: iss, bus: bus,
		publicBaseURL: baseURL,
		refreshTTL:    refreshTTL,
	}
}

type CreateTokenInput struct {
	TenantID  uuid.UUID
	CreatedBy uuid.UUID
	PolicyID  *uuid.UUID
	OneShot   bool
	MaxUses   int
	TTL       time.Duration
	ProvisioningMode string
}

// validProvisioningModes are the enrollment flows a token may select.
var validProvisioningModes = map[string]bool{
	// "stealth" provisions exactly as device_owner (Android has no separate
	// stealth provisioning) — the difference is the enroll response flags it so
	// the agent comes up with a hidden footprint.
	"device_owner": true, "work_profile": true, "device_admin": true, "stealth": true,
}

func (s *EnrollmentService) CreateToken(ctx context.Context, in CreateTokenInput) (*dto.CreateEnrollmentTokenResponse, error) {
	if in.MaxUses <= 0 {
		in.MaxUses = 1
	}
	if in.TTL <= 0 {
		in.TTL = 24 * time.Hour
	}
	mode := strings.TrimSpace(in.ProvisioningMode)
	if mode == "" {
		mode = "device_owner"
	}
	if !validProvisioningModes[mode] {
		return nil, apperr.New(apperr.CodeInvalidInput, "provisioning_mode must be one of device_owner, work_profile, device_admin, stealth")
	}
	tok, err := s.tokens.Create(ctx, in.TenantID, in.CreatedBy, in.PolicyID, in.OneShot, in.MaxUses, in.TTL, mode)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "create enrollment token", err)
	}
	return &dto.CreateEnrollmentTokenResponse{
		ID:           tok.ID.String(),
		Token:        tok.Token,
		ExpiresAt:    tok.ExpiresAt,
		QRURL:        fmt.Sprintf("%s/api/v1/enroll/qr/%s", s.publicBaseURL, tok.ID),
		ProvisionURL: fmt.Sprintf("%s/enroll?token=%s", s.publicBaseURL, tok.Token),
	}, nil
}

// defaultConfig returns the built-in provisioning config used when a tenant has
// not customised one in the UI.
func (s *EnrollmentService) defaultConfig(tenantID uuid.UUID) *models.EnrollmentConfig {
	return &models.EnrollmentConfig{
		TenantID:         tenantID,
		ServerBaseURL:    s.publicBaseURL,
		APKDownloadURL:   fmt.Sprintf("%s/api/v1/files/agent/latest.apk", s.publicBaseURL),
		DPCPackageName:   DPCPackageName,
		DPCComponentName: DPCComponent,
		WifiSecurityType: "WPA",
		SkipEncryption:   false,
		LeaveSystemApps:  true,
	}
}

// GetConfig returns the tenant's provisioning config, falling back to defaults.
func (s *EnrollmentService) GetConfig(ctx context.Context, tenantID uuid.UUID) (*models.EnrollmentConfig, error) {
	cfg, err := s.tokens.GetConfig(ctx, tenantID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return s.defaultConfig(tenantID), nil
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "load enrollment config", err)
	}
	return cfg, nil
}

var validWifiSecurity = map[string]bool{"NONE": true, "WPA": true, "WEP": true, "EAP": true}

// SaveConfig validates and persists a tenant's provisioning config.
func (s *EnrollmentService) SaveConfig(ctx context.Context, tenantID, userID uuid.UUID, in dto.EnrollmentConfigDTO) (*models.EnrollmentConfig, error) {
	sec := strings.ToUpper(strings.TrimSpace(in.WifiSecurityType))
	if sec == "" {
		sec = "WPA"
	}
	if !validWifiSecurity[sec] {
		return nil, apperr.New(apperr.CodeInvalidInput, "wifi_security_type must be one of NONE, WPA, WEP, EAP")
	}
	if in.WifiSSID != "" && sec != "NONE" && in.WifiPassword == "" {
		return nil, apperr.New(apperr.CodeInvalidInput, "wifi_password required when an SSID and a secured network type are set")
	}
	if in.DPCComponentName == "" {
		return nil, apperr.New(apperr.CodeInvalidInput, "dpc_component_name is required (e.g. com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver)")
	}
	cfg := &models.EnrollmentConfig{
		TenantID:             tenantID,
		ServerBaseURL:        strings.TrimSpace(in.ServerBaseURL),
		APKDownloadURL:       strings.TrimSpace(in.APKDownloadURL),
		APKSignatureChecksum: strings.TrimSpace(in.APKSignatureChecksum),
		DPCPackageName:       strings.TrimSpace(in.DPCPackageName),
		DPCComponentName:     strings.TrimSpace(in.DPCComponentName),
		WifiSSID:             in.WifiSSID,
		WifiPassword:         in.WifiPassword,
		WifiSecurityType:     sec,
		WifiHidden:           in.WifiHidden,
		SkipEncryption:       in.SkipEncryption,
		LeaveSystemApps:      in.LeaveSystemApps,
		UpdatedBy:            &userID,
	}
	if err := s.tokens.UpsertConfig(ctx, cfg); err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "save enrollment config", err)
	}
	events.Emit(ctx, s.bus, events.AuditEnvelope{
		TenantID:  tenantID.String(),
		ActorKind: "user",
		ActorID:   events.UUIDStrPtr(userID),
		Action:    "enroll.config.updated",
	})
	return cfg, nil
}

// BuildQRPayload returns the JSON that should be encoded into the QR. The
// Android Setup Wizard reads this as the `provisioning` extras bundle. It is
// built from the tenant's saved provisioning config (or built-in defaults).
func (s *EnrollmentService) BuildQRPayload(ctx context.Context, tokenID uuid.UUID) (dto.QRPayload, error) {
	tok, err := s.tokens.GetByID(ctx, tokenID)
	if err != nil {
		return dto.QRPayload{}, apperr.New(apperr.CodeNotFound, "enrollment token not found")
	}
	if time.Now().After(tok.ExpiresAt) {
		return dto.QRPayload{}, apperr.New(apperr.CodeConflict, "enrollment token expired")
	}
	cfg, err := s.GetConfig(ctx, tok.TenantID)
	if err != nil {
		return dto.QRPayload{}, err
	}
	// Effective server URL the device phones home to — tenant override, else the
	// service default. localhost won't work on a real device, so admins set a
	// reachable LAN IP / domain here.
	base := cfg.ServerBaseURL
	if base == "" {
		base = s.publicBaseURL
	}
	download := cfg.APKDownloadURL
	if download == "" {
		// Include the tenant ID so the public endpoint knows which tenant's APK
		// to serve — Android Setup Wizard calls this without any auth token.
		download = fmt.Sprintf("%s/api/v1/files/agent/latest.apk?tenant=%s", base, tok.TenantID.String())
	}
	extras := map[string]string{
		"server_url":        base,
		"enrollment_token":  tok.Token,
		"tenant_id":         tok.TenantID.String(),
		"provisioning_mode": tok.ProvisioningMode,
	}
	payload := dto.QRPayload{
		DPCComponent:              cfg.DPCComponentName,
		DPCPackage:                cfg.DPCPackageName,
		DPCSignatureChecksum:      cfg.APKSignatureChecksum,
		DPCDownloadLocation:       download,
		SkipEncryption:            cfg.SkipEncryption,
		LeaveAllSystemAppsEnabled: cfg.LeaveSystemApps,
		AdminExtras:               extras,
	}
	// Only emit WiFi extras when an SSID is configured — otherwise the operator
	// joins a network manually during setup.
	if cfg.WifiSSID != "" {
		payload.WifiSSID = cfg.WifiSSID
		payload.WifiSecurityType = cfg.WifiSecurityType
		payload.WifiHidden = cfg.WifiHidden
		if cfg.WifiSecurityType != "NONE" {
			payload.WifiPassword = cfg.WifiPassword
		}
	}
	return payload, nil
}

func (s *EnrollmentService) Enroll(ctx context.Context, in dto.EnrollRequest) (*dto.EnrollResponse, error) {
	if in.Token == "" {
		return nil, apperr.New(apperr.CodeInvalidInput, "token required")
	}
	tok, err := s.tokens.GetByToken(ctx, in.Token)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, apperr.New(apperr.CodeUnauthorized, "invalid enrollment token")
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "find token", err)
	}
	consumed, err := s.tokens.ConsumeOne(ctx, tok.ID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, apperr.New(apperr.CodeConflict, "enrollment token exhausted or expired")
		}
		return nil, apperr.Wrap(apperr.CodeInternal, "consume token", err)
	}

	dev := &models.Device{
		TenantID:           consumed.TenantID,
		EnrollmentTokenID:  &consumed.ID,
		EnrollmentChannel:  optStr(normalizeEnum(in.EnrollmentChannel, validEnrollmentChannels)),
		ManagementMode:     optStr(normalizeEnum(in.ManagementMode, validManagementModes)),
		SerialNumber:       optStr(in.SerialNumber),
		IMEI:               optStr(in.IMEI),
		AndroidID:          optStr(in.AndroidID),
		Manufacturer:       optStr(in.Manufacturer),
		Model:              optStr(in.Model),
		OSVersion:          optStr(in.OSVersion),
		SecurityPatchLevel: optStr(in.SecurityPatch),
		State:              models.DeviceStateEnrolled,
		AssignedPolicyID:   consumed.PolicyID,
		Tags:               json.RawMessage(`{}`),
		Metadata:           json.RawMessage(`{}`),
	}
	if err := s.devices.Create(ctx, dev); err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "create device", err)
	}

	access, err := s.issuer.IssueDevice(dev.ID, dev.TenantID)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "issue device token", err)
	}
	// Device refresh token: persist with kind='device' so the agent can
	// rotate its access token via /auth/refresh without re-enrolling.
	refreshPlain, refreshHash, err := auth.NewRefreshToken()
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "refresh token", err)
	}
	ttl := s.refreshTTL
	if ttl <= 0 {
		ttl = 168 * time.Hour
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO refresh_tokens
	  (id, tenant_id, subject_id, kind, token_hash, issued_at, expires_at)
	  VALUES ($1,$2,$3,'device',$4,$5,$6)`,
		uuid.New(), dev.TenantID, dev.ID, refreshHash, time.Now(), time.Now().Add(ttl),
	); err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "persist refresh token", err)
	}

	// Publish enrollment event for downstream consumers (audit, policy assign).
	if s.bus != nil {
		evt, _ := json.Marshal(map[string]any{
			"device_id": dev.ID,
			"tenant_id": dev.TenantID,
			"policy_id": consumed.PolicyID,
			"at":        time.Now(),
		})
		_, _ = s.bus.JS.Publish("mdm.device.enrolled", evt, nats.AckWait(2*time.Second))
	}
	auditMeta, _ := json.Marshal(map[string]any{
		"serial_number": dev.SerialNumber,
		"manufacturer":  dev.Manufacturer,
		"model":         dev.Model,
		"os_version":    dev.OSVersion,
	})
	events.Emit(ctx, s.bus, events.AuditEnvelope{
		TenantID:   dev.TenantID.String(),
		ActorKind:  "device",
		ActorID:    events.UUIDStrPtr(dev.ID),
		Action:     "device.enrolled",
		TargetKind: events.StrPtr("device"),
		TargetID:   events.UUIDStrPtr(dev.ID),
		Metadata:   auditMeta,
	})

	// Deliver the global debug-unlock hash so the device "initially receives the
	// password" at enrollment (the agent caches it for offline verification).
	debugPw, _ := s.tokens.PlatformDebugPassword(ctx)

	return &dto.EnrollResponse{
		DeviceID:     dev.ID.String(),
		TenantID:     dev.TenantID.String(),
		AccessToken:  access,
		RefreshToken: refreshPlain,
		MQTTTopic:    fmt.Sprintf("mdm/%s/devices/%s/cmd", dev.TenantID, dev.ID),
		MQTTUser:     "device-" + dev.ID.String(),
		PolicyURL:    fmt.Sprintf("%s/api/v1/policies/assigned", s.publicBaseURL),
		HeartbeatSec: 60,
		DebugUnlock:  DebugUnlockHash(debugPw),
		// Stealth was selected at token creation → tell the agent to come up with
		// a hidden footprint (it still provisions as a full Device Owner).
		Stealth: tok.ProvisioningMode == "stealth",
	}, nil
}

func optStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

var validEnrollmentChannels = map[string]bool{
	"qr_setup": true, "qr_inapp": true, "direct_install": true, "adb": true,
}

var validManagementModes = map[string]bool{
	"device_owner": true, "profile_owner": true, "device_admin": true,
}

// normalizeEnum lower-cases/trims an agent-reported enum and returns it only if
// it's in the allowed set; otherwise "" (→ NULL column) so a malformed value
// can't pollute the record.
func normalizeEnum(v string, allowed map[string]bool) string {
	v = strings.ToLower(strings.TrimSpace(v))
	if allowed[v] {
		return v
	}
	return ""
}

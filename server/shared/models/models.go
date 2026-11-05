// Package models holds the canonical domain types shared across services.
//
// These structs are deliberately kept simple: persistence-layer concerns
// (foreign key columns, soft-delete columns) live alongside business fields
// because every service reads/writes the same Postgres schema.
package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// ----------------- Tenant ----------------------------------------------------

type Tenant struct {
	ID        uuid.UUID  `db:"id" json:"id"`
	Slug      string     `db:"slug" json:"slug"`
	Name      string     `db:"name" json:"name"`
	CreatedAt time.Time  `db:"created_at" json:"created_at"`
	UpdatedAt time.Time  `db:"updated_at" json:"updated_at"`
	DeletedAt *time.Time `db:"deleted_at" json:"deleted_at,omitempty"`
}

// ----------------- User / RBAC -----------------------------------------------

type Role string

const (
	RoleSuperAdmin Role = "super_admin"
	RoleAdmin      Role = "admin"
	RoleOperator   Role = "operator"
	RoleViewer     Role = "viewer"
)

type User struct {
	ID           uuid.UUID  `db:"id" json:"id"`
	TenantID     uuid.UUID  `db:"tenant_id" json:"tenant_id"`
	Email        string     `db:"email" json:"email"`
	PasswordHash string     `db:"password_hash" json:"-"`
	Role         Role       `db:"role" json:"role"`
	MFAEnabled   bool       `db:"mfa_enabled" json:"mfa_enabled"`
	MFASecret    *string    `db:"mfa_secret" json:"-"`
	LastLoginAt  *time.Time `db:"last_login_at" json:"last_login_at,omitempty"`
	CreatedAt    time.Time  `db:"created_at" json:"created_at"`
	UpdatedAt    time.Time  `db:"updated_at" json:"updated_at"`
	DeletedAt    *time.Time `db:"deleted_at" json:"deleted_at,omitempty"`
}

type RefreshToken struct {
	ID         uuid.UUID  `db:"id"`
	TenantID   uuid.UUID  `db:"tenant_id"`
	SubjectID  uuid.UUID  `db:"subject_id"` // user_id or device_id
	Kind       string     `db:"kind"`       // "user" | "device"
	TokenHash  string     `db:"token_hash"`
	IssuedAt   time.Time  `db:"issued_at"`
	ExpiresAt  time.Time  `db:"expires_at"`
	RevokedAt  *time.Time `db:"revoked_at"`
	ReplacedBy *uuid.UUID `db:"replaced_by"`
	UserAgent  *string    `db:"user_agent"`
	IPAddr     *string    `db:"ip_addr"`
}

// ----------------- Device -----------------------------------------------------

type DeviceState string

const (
	DeviceStatePending    DeviceState = "pending"     // enrollment token issued, not yet checked in
	DeviceStateEnrolled   DeviceState = "enrolled"    // active
	DeviceStateOffline    DeviceState = "offline"     // missed heartbeats
	DeviceStateWiped      DeviceState = "wiped"       // wipe acknowledged
	DeviceStateRetired    DeviceState = "retired"     // soft retired
)

type Device struct {
	ID                  uuid.UUID       `db:"id" json:"id"`
	TenantID            uuid.UUID       `db:"tenant_id" json:"tenant_id"`
	EnrollmentTokenID   *uuid.UUID      `db:"enrollment_token_id" json:"enrollment_token_id,omitempty"`
	// EnrollmentChannel records HOW the device enrolled: qr_setup | qr_inapp |
	// direct_install | adb. ManagementMode records the role it holds:
	// device_owner | profile_owner | device_admin. Both are reported by the
	// agent at enroll time (nil for devices enrolled before this was tracked).
	EnrollmentChannel   *string         `db:"enrollment_channel" json:"enrollment_channel,omitempty"`
	ManagementMode      *string         `db:"management_mode" json:"management_mode,omitempty"`
	SerialNumber        *string         `db:"serial_number" json:"serial_number,omitempty"`
	IMEI                *string         `db:"imei" json:"imei,omitempty"`
	AndroidID           *string         `db:"android_id" json:"android_id,omitempty"`
	Manufacturer        *string         `db:"manufacturer" json:"manufacturer,omitempty"`
	Model               *string         `db:"model" json:"model,omitempty"`
	OSVersion           *string         `db:"os_version" json:"os_version,omitempty"`
	SecurityPatchLevel  *string         `db:"security_patch_level" json:"security_patch_level,omitempty"`
	Alias               *string         `db:"alias" json:"alias,omitempty"`
	State               DeviceState     `db:"state" json:"state"`
	LastHeartbeatAt     *time.Time      `db:"last_heartbeat_at" json:"last_heartbeat_at,omitempty"`
	AssignedPolicyID    *uuid.UUID      `db:"assigned_policy_id" json:"assigned_policy_id,omitempty"`
	AppliedPolicyVer    int             `db:"applied_policy_version" json:"applied_policy_version"`
	LastLatitude        *float64        `db:"last_latitude" json:"last_latitude,omitempty"`
	LastLongitude       *float64        `db:"last_longitude" json:"last_longitude,omitempty"`
	LastLocationAccuracyM *float32      `db:"last_location_accuracy_m" json:"last_location_accuracy_m,omitempty"`
	LastLocationAt      *time.Time      `db:"last_location_at" json:"last_location_at,omitempty"`
	LastIPAddress       *string         `db:"last_ip_address" json:"last_ip_address,omitempty"`
	LastMACAddress      *string         `db:"last_mac_address" json:"last_mac_address,omitempty"`
	LastBatteryPct      *int            `db:"last_battery_pct" json:"last_battery_pct,omitempty"`
	LastCharging        *bool           `db:"last_charging" json:"last_charging,omitempty"`
	LastVpnActive       *bool           `db:"last_vpn_active" json:"last_vpn_active,omitempty"`
	LastStorageFreeBytes *int64         `db:"last_storage_free_bytes" json:"last_storage_free_bytes,omitempty"`
	LastWifiSsid        *string         `db:"last_wifi_ssid" json:"last_wifi_ssid,omitempty"`
	LastNetworkType     *string         `db:"last_network_type" json:"last_network_type,omitempty"`
	LastMgmtMode        *string         `db:"last_mgmt_mode" json:"last_mgmt_mode,omitempty"` // owner | profile | admin | none
	AgentVersion        *string         `db:"agent_version" json:"agent_version,omitempty"`        // versionName, reported on heartbeat
	AgentVersionCode    *int64          `db:"agent_version_code" json:"agent_version_code,omitempty"` // versionCode (bumps each build)
	LastPostureScore    *int            `db:"last_posture_score" json:"last_posture_score,omitempty"`   // 0-100 attestation score
	LastPostureFactors  *json.RawMessage `db:"last_posture_factors" json:"last_posture_factors,omitempty"` // nullable: NULL until first attestation — pointer so sqlx can scan SQL NULL (see CommandResult.Result)
	LastPostureAt       *time.Time      `db:"last_posture_at" json:"last_posture_at,omitempty"`

	GroupID             *uuid.UUID      `db:"group_id" json:"group_id,omitempty"`
	Tags                json.RawMessage `db:"tags" json:"tags,omitempty"`
	Metadata            json.RawMessage `db:"metadata" json:"metadata,omitempty"`
	CreatedAt           time.Time       `db:"created_at" json:"created_at"`
	UpdatedAt           time.Time       `db:"updated_at" json:"updated_at"`
	DeletedAt           *time.Time      `db:"deleted_at" json:"deleted_at,omitempty"`
	Version             int             `db:"version" json:"version"` // optimistic locking
}

// DeviceSnapshot is an append-only point-in-time record of a device's state,
// powering fleet time-travel. Written (throttled) on heartbeat.
type DeviceSnapshot struct {
	ID               uuid.UUID  `db:"id" json:"id"`
	TenantID         uuid.UUID  `db:"tenant_id" json:"tenant_id"`
	DeviceID         uuid.UUID  `db:"device_id" json:"device_id"`
	CapturedAt       time.Time  `db:"captured_at" json:"captured_at"`
	State            *string    `db:"state" json:"state,omitempty"`
	MgmtMode         *string    `db:"mgmt_mode" json:"mgmt_mode,omitempty"`
	AppliedPolicyVer *int       `db:"applied_policy_version" json:"applied_policy_version,omitempty"`
	BatteryPct       *int       `db:"battery_pct" json:"battery_pct,omitempty"`
	Charging         *bool      `db:"charging" json:"charging,omitempty"`
	NetworkType      *string    `db:"network_type" json:"network_type,omitempty"`
	WifiSsid         *string    `db:"wifi_ssid" json:"wifi_ssid,omitempty"`
	IPAddress        *string    `db:"ip_address" json:"ip_address,omitempty"`
	Latitude         *float64   `db:"latitude" json:"latitude,omitempty"`
	Longitude        *float64   `db:"longitude" json:"longitude,omitempty"`
	AccuracyM        *float32   `db:"accuracy_m" json:"accuracy_m,omitempty"`
	// Joined for convenience in fleet/time-travel responses (not columns).
	Alias        *string `db:"alias" json:"alias,omitempty"`
	SerialNumber *string `db:"serial_number" json:"serial_number,omitempty"`
}

// ----------------- Device Group ----------------------------------------------

// DeviceGroup is a tenant-scoped label for classifying devices (e.g.
// "Employees", "Interns"). Policies assigned to a group apply to every device
// whose group_id matches — resolved/merged by policy-service alongside
// device- and tenant-level assignments.
type DeviceGroup struct {
	ID          uuid.UUID  `db:"id" json:"id"`
	TenantID    uuid.UUID  `db:"tenant_id" json:"tenant_id"`
	Name        string     `db:"name" json:"name"`
	Description *string    `db:"description" json:"description,omitempty"`
	CreatedAt   time.Time  `db:"created_at" json:"created_at"`
	UpdatedAt   time.Time  `db:"updated_at" json:"updated_at"`
	DeletedAt   *time.Time `db:"deleted_at" json:"deleted_at,omitempty"`
	// DeviceCount is populated by list queries (not a column).
	DeviceCount int `db:"device_count" json:"device_count"`
}

// ----------------- Enrollment Token ------------------------------------------

type EnrollmentToken struct {
	ID         uuid.UUID  `db:"id" json:"id"`
	TenantID   uuid.UUID  `db:"tenant_id" json:"tenant_id"`
	PolicyID   *uuid.UUID `db:"policy_id" json:"policy_id,omitempty"`
	Token      string     `db:"token" json:"token"`
	// ProvisioningMode selects the Android enrollment flow the token drives:
	// device_owner (fully-managed) | work_profile (BYOD Profile Owner) |
	// device_admin (legacy). Defaults to device_owner.
	ProvisioningMode string `db:"provisioning_mode" json:"provisioning_mode"`
	OneShot    bool       `db:"one_shot" json:"one_shot"`
	UsedCount  int        `db:"used_count" json:"used_count"`
	MaxUses    int        `db:"max_uses" json:"max_uses"`
	ExpiresAt  time.Time  `db:"expires_at" json:"expires_at"`
	CreatedBy  uuid.UUID  `db:"created_by" json:"created_by"`
	CreatedAt  time.Time  `db:"created_at" json:"created_at"`
}

// EnrollmentConfig is the per-tenant Android Device-Owner QR provisioning
// configuration, editable by admin/super_admin. Drives the QR payload.
type EnrollmentConfig struct {
	TenantID             uuid.UUID  `db:"tenant_id" json:"tenant_id"`
	ServerBaseURL        string     `db:"server_base_url" json:"server_base_url"`
	APKDownloadURL       string     `db:"apk_download_url" json:"apk_download_url"`
	APKSignatureChecksum string     `db:"apk_signature_checksum" json:"apk_signature_checksum"`
	DPCPackageName       string     `db:"dpc_package_name" json:"dpc_package_name"`
	DPCComponentName     string     `db:"dpc_component_name" json:"dpc_component_name"`
	WifiSSID             string     `db:"wifi_ssid" json:"wifi_ssid"`
	WifiPassword         string     `db:"wifi_password" json:"wifi_password"`
	WifiSecurityType     string     `db:"wifi_security_type" json:"wifi_security_type"` // NONE | WPA | WEP | EAP
	WifiHidden           bool       `db:"wifi_hidden" json:"wifi_hidden"`
	SkipEncryption       bool       `db:"skip_encryption" json:"skip_encryption"`
	LeaveSystemApps      bool       `db:"leave_system_apps" json:"leave_system_apps"`
	UpdatedAt            time.Time  `db:"updated_at" json:"updated_at"`
	UpdatedBy            *uuid.UUID `db:"updated_by" json:"updated_by,omitempty"`
}

// PlatformSettings is the single global (cross-tenant) settings row. Holds the
// debug-unlock password that gates the agent's hidden in-app config panel.
// Editable by admin/super_admin (platform:manage).
type PlatformSettings struct {
	DebugUnlockPassword string     `db:"debug_unlock_password" json:"debug_unlock_password"`
	UpdatedAt           time.Time  `db:"updated_at" json:"updated_at"`
	UpdatedBy           *uuid.UUID `db:"updated_by" json:"updated_by,omitempty"`
}

// ----------------- Policy ----------------------------------------------------

type Policy struct {
	ID         uuid.UUID       `db:"id" json:"id"`
	TenantID   uuid.UUID       `db:"tenant_id" json:"tenant_id"`
	Name       string          `db:"name" json:"name"`
	Version    int             `db:"version" json:"version"`
	Spec       json.RawMessage `db:"spec" json:"spec"` // full PolicySpec JSON; see android-agent/policy-engine
	CreatedBy  uuid.UUID       `db:"created_by" json:"created_by"`
	CreatedAt  time.Time       `db:"created_at" json:"created_at"`
	UpdatedAt  time.Time       `db:"updated_at" json:"updated_at"`
	DeletedAt  *time.Time      `db:"deleted_at" json:"deleted_at,omitempty"`
}

type PolicyAssignment struct {
	ID         uuid.UUID  `db:"id" json:"id"`
	TenantID   uuid.UUID  `db:"tenant_id" json:"tenant_id"`
	PolicyID   uuid.UUID  `db:"policy_id" json:"policy_id"`
	TargetKind string     `db:"target_kind" json:"target_kind"`
	TargetID   *uuid.UUID `db:"target_id" json:"target_id,omitempty"`
	CreatedAt  time.Time  `db:"created_at" json:"created_at"`
}

// ----------------- Command ---------------------------------------------------

type CommandState string

const (
	CommandStatePending      CommandState = "pending"
	CommandStateDispatched   CommandState = "dispatched"
	CommandStateAcknowledged CommandState = "acknowledged"
	CommandStateSucceeded    CommandState = "succeeded"
	CommandStateFailed       CommandState = "failed"
	CommandStateTimedOut     CommandState = "timed_out"
)

type Command struct {
	ID            uuid.UUID       `db:"id" json:"id"`
	TenantID      uuid.UUID       `db:"tenant_id" json:"tenant_id"`
	DeviceID      uuid.UUID       `db:"device_id" json:"device_id"`
	Kind          string          `db:"kind" json:"kind"`        // LOCK, WIPE, REBOOT, INSTALL_APK, ...
	Payload       json.RawMessage `db:"payload" json:"payload"`
	State         CommandState    `db:"state" json:"state"`
	Attempts      int             `db:"attempts" json:"attempts"`
	MaxAttempts   int             `db:"max_attempts" json:"max_attempts"`
	LastError     *string         `db:"last_error" json:"last_error,omitempty"`
	// Pointer so a NULL row scans cleanly. Without this database/sql refuses
	// to materialise NULL into a non-pointer json.RawMessage and we get
	// "unsupported Scan, storing driver.Value type <nil> into type *json.RawMessage".
	Result        *json.RawMessage `db:"result" json:"result,omitempty"`
	DispatchedAt  *time.Time      `db:"dispatched_at" json:"dispatched_at,omitempty"`
	AckedAt       *time.Time      `db:"acked_at" json:"acked_at,omitempty"`
	CompletedAt   *time.Time      `db:"completed_at" json:"completed_at,omitempty"`
	TimeoutAt     time.Time       `db:"timeout_at" json:"timeout_at"`
	CreatedBy     uuid.UUID       `db:"created_by" json:"created_by"`
	CreatedAt     time.Time       `db:"created_at" json:"created_at"`
}

// ----------------- Telemetry --------------------------------------------------

type TelemetryEvent struct {
	ID        uuid.UUID       `db:"id" json:"id"`
	TenantID  uuid.UUID       `db:"tenant_id" json:"tenant_id"`
	DeviceID  uuid.UUID       `db:"device_id" json:"device_id"`
	Kind      string          `db:"kind" json:"kind"`
	Payload   json.RawMessage `db:"payload" json:"payload"`
	CapturedAt time.Time      `db:"captured_at" json:"captured_at"`
	ReceivedAt time.Time      `db:"received_at" json:"received_at"`
}

// ----------------- File ------------------------------------------------------

type FileObject struct {
	ID               uuid.UUID  `db:"id" json:"id"`
	TenantID         uuid.UUID  `db:"tenant_id" json:"tenant_id"`
	Name             string     `db:"name" json:"name"`
	Kind             string     `db:"kind" json:"kind"` // "apk", "log", "generic", "config", "photo"
	StorageKey       string     `db:"storage_key" json:"storage_key"`
	SHA256           string     `db:"sha256" json:"sha256"`
	SizeBytes        int64      `db:"size_bytes" json:"size_bytes"`
	ContentType      string     `db:"content_type" json:"content_type"`
	UploadedBy       *uuid.UUID `db:"uploaded_by" json:"uploaded_by,omitempty"`
	UploadedByDevice *uuid.UUID `db:"uploaded_by_device" json:"uploaded_by_device,omitempty"`
	DeviceID         *uuid.UUID `db:"device_id" json:"device_id,omitempty"`
	CreatedAt        time.Time  `db:"created_at" json:"created_at"`
	DeletedAt        *time.Time `db:"deleted_at" json:"deleted_at,omitempty"`
}

// ----------------- Audit -----------------------------------------------------

type AuditEntry struct {
	ID         uuid.UUID       `db:"id" json:"id"`
	TenantID   uuid.UUID       `db:"tenant_id" json:"tenant_id"`
	ActorID    *uuid.UUID      `db:"actor_id" json:"actor_id,omitempty"`
	ActorKind  string          `db:"actor_kind" json:"actor_kind"` // "user" | "device" | "system"
	Action     string          `db:"action" json:"action"`
	TargetKind *string         `db:"target_kind" json:"target_kind,omitempty"`
	TargetID   *uuid.UUID      `db:"target_id" json:"target_id,omitempty"`
	Metadata   json.RawMessage `db:"metadata" json:"metadata,omitempty"`
	PrevHash   string          `db:"prev_hash" json:"prev_hash"`
	Hash       string          `db:"hash" json:"hash"`
	CreatedAt  time.Time       `db:"created_at" json:"created_at"`
}

package dto

import "time"

// ---------- enrollment ----------

type CreateEnrollmentTokenRequest struct {
	PolicyID  *string `json:"policy_id,omitempty"`
	OneShot   bool    `json:"one_shot"`
	MaxUses   int     `json:"max_uses"`
	ExpiresIn string  `json:"expires_in"` // duration, e.g. "24h"
	// ProvisioningMode: device_owner (default) | work_profile | device_admin.
	ProvisioningMode string `json:"provisioning_mode,omitempty"`
}

type CreateEnrollmentTokenResponse struct {
	ID         string    `json:"id"`
	Token      string    `json:"token"`
	ExpiresAt  time.Time `json:"expires_at"`
	QRURL      string    `json:"qr_url"`       // GET this for the JSON QR payload
	ProvisionURL string  `json:"provision_url"` // direct deep link
}

type EnrollRequest struct {
	Token        string `json:"token"`
	SerialNumber string `json:"serial_number,omitempty"`
	IMEI         string `json:"imei,omitempty"`
	AndroidID    string `json:"android_id,omitempty"`
	Manufacturer string `json:"manufacturer,omitempty"`
	Model        string `json:"model,omitempty"`
	OSVersion    string `json:"os_version,omitempty"`
	SecurityPatch string `json:"security_patch_level,omitempty"`
	// EnrollmentChannel: qr_setup | qr_inapp | direct_install | adb.
	EnrollmentChannel string `json:"enrollment_channel,omitempty"`
	// ManagementMode: device_owner | profile_owner | device_admin.
	ManagementMode string `json:"management_mode,omitempty"`
}

type EnrollResponse struct {
	DeviceID     string `json:"device_id"`
	TenantID     string `json:"tenant_id"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	MQTTTopic    string `json:"mqtt_topic"`
	MQTTUser     string `json:"mqtt_user"`
	PolicyURL    string `json:"policy_url"`
	HeartbeatSec int    `json:"heartbeat_sec"`
	// Stealth ⇒ the agent comes up with a hidden footprint (no launcher icon,
	// generic notification, no branding). It still provisions as a full Device
	// Owner; only the on-screen presence differs. Set when the enrollment token's
	// provisioning_mode is "stealth".
	Stealth bool `json:"stealth,omitempty"`
	// DebugUnlock is the hash of the global debug-unlock password (empty when
	// none is configured). The agent caches it and verifies the operator's
	// on-device input locally — so the hidden config panel works offline. The
	// plaintext is never sent.
	DebugUnlock string `json:"debug_unlock,omitempty"`
}

// PlatformSettingsDTO is the admin GET/PUT body for global platform settings
// (GET/PUT /api/v1/enroll/platform-settings). debug_unlock_password is stored
// and returned in plaintext for the operator to view/rotate; devices only ever
// receive its hash (EnrollResponse.DebugUnlock / HeartbeatResponse.DebugUnlock).
type PlatformSettingsDTO struct {
	DebugUnlockPassword string `json:"debug_unlock_password"`
}

// HeartbeatResponse is the body returned from POST /devices/me/heartbeat. It
// carries the current debug-unlock hash so a password set/rotated AFTER a device
// enrolled still reaches it (refreshed every heartbeat).
type HeartbeatResponse struct {
	DebugUnlock string `json:"debug_unlock,omitempty"`
}

// QRPayload mirrors the Android Device-Owner provisioning extras encoded into
// the enrollment QR. Keys are the exact android.app.extra.PROVISIONING_* names
// the Setup Wizard reads. The component name MUST be the "pkg/.Receiver" string
// (PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME); the WiFi keys let a freshly
// factory-reset device join a network during setup, before downloading the APK.
type QRPayload struct {
	DPCComponent              string            `json:"android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME"`
	DPCPackage                string            `json:"android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_NAME,omitempty"`
	DPCSignatureChecksum      string            `json:"android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM,omitempty"`
	DPCDownloadLocation       string            `json:"android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION"`
	WifiSSID                  string            `json:"android.app.extra.PROVISIONING_WIFI_SSID,omitempty"`
	WifiPassword              string            `json:"android.app.extra.PROVISIONING_WIFI_PASSWORD,omitempty"`
	WifiSecurityType          string            `json:"android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE,omitempty"`
	WifiHidden                bool              `json:"android.app.extra.PROVISIONING_WIFI_HIDDEN,omitempty"`
	SkipEncryption            bool              `json:"android.app.extra.PROVISIONING_SKIP_ENCRYPTION"`
	LeaveAllSystemAppsEnabled bool              `json:"android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED"`
	AdminExtras               map[string]string `json:"android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE"`
}

// EnrollmentConfigDTO is the admin-editable provisioning config (GET/PUT
// /api/v1/enroll/config). Mirrors models.EnrollmentConfig minus audit fields.
type EnrollmentConfigDTO struct {
	ServerBaseURL        string `json:"server_base_url"`
	APKDownloadURL       string `json:"apk_download_url"`
	APKSignatureChecksum string `json:"apk_signature_checksum"`
	DPCPackageName       string `json:"dpc_package_name"`
	DPCComponentName     string `json:"dpc_component_name"`
	WifiSSID             string `json:"wifi_ssid"`
	WifiPassword         string `json:"wifi_password"`
	WifiSecurityType     string `json:"wifi_security_type"`
	WifiHidden           bool   `json:"wifi_hidden"`
	SkipEncryption       bool   `json:"skip_encryption"`
	LeaveSystemApps      bool   `json:"leave_system_apps"`
}

// ---------- devices ----------

type HeartbeatRequest struct {
	Battery            *int     `json:"battery_pct,omitempty"`
	Charging           *bool    `json:"charging,omitempty"`
	NetworkType        *string  `json:"network_type,omitempty"`
	VpnActive          *bool    `json:"vpn_active,omitempty"`
	AppliedPolicyVer   *int     `json:"applied_policy_version,omitempty"`
	Latitude           *float64 `json:"latitude,omitempty"`
	Longitude          *float64 `json:"longitude,omitempty"`
	LocationAccuracyM  *float32 `json:"location_accuracy_m,omitempty"`
	IPAddress          *string  `json:"ip_address,omitempty"`
	MACAddress         *string  `json:"mac_address,omitempty"`
	StorageFreeBytes   *int64   `json:"storage_free_bytes,omitempty"`
	WifiSsid           *string  `json:"wifi_ssid,omitempty"`
	MgmtMode           *string  `json:"mgmt_mode,omitempty"` // owner | profile | admin | none
	AgentVersion       *string  `json:"agent_version,omitempty"`
	AgentVersionCode   *int64   `json:"agent_version_code,omitempty"`
	// Attestation / posture signals (continuous device-health):
	Rooted     *bool `json:"rooted,omitempty"`
	Debuggable *bool `json:"debuggable,omitempty"`
	Emulator   *bool `json:"emulator,omitempty"`
	AdbEnabled *bool `json:"adb_enabled,omitempty"`
	LockSecure *bool `json:"lock_secure,omitempty"` // a secure lock screen (PIN/pattern/biometric) is set
}

// UpdateDeviceRequest is the admin-side PATCH /devices/:id body. Only the
// fields present are touched; today that's the alias. `alias` is a pointer so
// the handler can tell "not supplied" (nil → no change) apart from "clear it"
// (explicit empty string).
type UpdateDeviceRequest struct {
	Alias *string `json:"alias,omitempty"`
	// GroupID: a UUID string to assign the device to a group, or an explicit
	// empty string "" to clear group membership. Omitted (nil) = no change.
	GroupID *string `json:"group_id,omitempty"`
}

// ---------- device groups ----------

type CreateGroupRequest struct {
	Name        string  `json:"name"`
	Description *string `json:"description,omitempty"`
}

type UpdateGroupRequest struct {
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
}

type UpdateDeviceInfoRequest struct {
	Manufacturer        *string `json:"manufacturer,omitempty"`
	Model               *string `json:"model,omitempty"`
	OSVersion           *string `json:"os_version,omitempty"`
	SecurityPatchLevel  *string `json:"security_patch_level,omitempty"`
}

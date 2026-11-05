// Package spec defines the canonical PolicySpec the platform serializes. The
// Android agent's policy-engine consumes the same shape; keep them in sync.
//
// All fields are pointers so a partial policy can override only specific
// settings (and so the agent can detect "unset" vs "false").
package spec

type PolicySpec struct {
	Version int `json:"version"`

	// Restrictions correspond to DevicePolicyManager.addUserRestriction(...)
	Restrictions *Restrictions `json:"restrictions,omitempty"`

	// Password complexity policy.
	Password *PasswordPolicy `json:"password,omitempty"`

	// Apps to install / uninstall / hide.
	Apps *AppPolicy `json:"apps,omitempty"`

	// Network settings to apply.
	Network *NetworkPolicy `json:"network,omitempty"`

	// System update behaviour (auto, postpone, windowed install).
	SystemUpdate *SystemUpdatePolicy `json:"system_update,omitempty"`

	// Certificates to install in the managed-profile trust store.
	Certificates []Certificate `json:"certificates,omitempty"`

	// Compliance: what device states are acceptable (root, patch level, etc.)
	Compliance *CompliancePolicy `json:"compliance,omitempty"`

	// WorkProfile: controls that only apply when the agent is a Profile Owner
	// (BYOD work profile). Ignored on Device Owner / Device Admin devices.
	WorkProfile *WorkProfilePolicy `json:"work_profile,omitempty"`

	// ManagedAppConfigs: per-app managed configuration bundles pushed via
	// setApplicationRestrictions. Works for both Device Owner and Profile
	// Owner. Keys/values are app-defined (e.g. Chrome's URLBlocklist).
	ManagedAppConfigs []ManagedAppConfig `json:"managed_app_configs,omitempty"`
}

type Restrictions struct {
	DisableCamera          *bool `json:"disable_camera,omitempty"`
	DisableScreenCapture   *bool `json:"disable_screen_capture,omitempty"`
	DisableUSBFileTransfer *bool `json:"disable_usb_file_transfer,omitempty"`
	DisableBluetooth       *bool `json:"disable_bluetooth,omitempty"`
	DisableNFC             *bool `json:"disable_nfc,omitempty"`
	DisableHotspot         *bool `json:"disable_hotspot,omitempty"`
	DisableLocation        *bool `json:"disable_location,omitempty"`
	DisableUnknownSources  *bool `json:"disable_unknown_sources,omitempty"`
	DisableAccessibility   *bool `json:"disable_accessibility,omitempty"`
	DisableFactoryReset    *bool `json:"disable_factory_reset,omitempty"`
	DisableSafeBoot        *bool `json:"disable_safe_boot,omitempty"`
	DisableAddUser         *bool `json:"disable_add_user,omitempty"`
}

type PasswordComplexity string

const (
	PasswordComplexityNone   PasswordComplexity = "none"
	PasswordComplexityLow    PasswordComplexity = "low"
	PasswordComplexityMedium PasswordComplexity = "medium"
	PasswordComplexityHigh   PasswordComplexity = "high"
)

type PasswordPolicy struct {
	Complexity         PasswordComplexity `json:"complexity"`
	MinLength          *int               `json:"min_length,omitempty"`
	ExpirationDays     *int               `json:"expiration_days,omitempty"`
	HistoryLength      *int               `json:"history_length,omitempty"`
	MaxFailedAttempts  *int               `json:"max_failed_attempts,omitempty"` // 0 disables wipe
	InactivityLockSec  *int               `json:"inactivity_lock_sec,omitempty"`
}

type AppPolicy struct {
	Install        []ManagedApp `json:"install,omitempty"`         // ensure installed
	Uninstall      []string     `json:"uninstall,omitempty"`       // package names to remove
	BlockedPackages []string    `json:"blocked_packages,omitempty"` // setApplicationHidden(true)
	Whitelist      []string     `json:"whitelist,omitempty"`       // if non-empty, all others are hidden
	PreventUninstallPackages []string `json:"prevent_uninstall_packages,omitempty"`
}

type ManagedApp struct {
	PackageName    string `json:"package_name"`
	VersionCode    int64  `json:"version_code,omitempty"`
	DownloadURL    string `json:"download_url,omitempty"`
	SigningSHA256  string `json:"signing_sha256,omitempty"`
	InstallMode    string `json:"install_mode,omitempty"` // "auto" | "available"
}

type NetworkPolicy struct {
	WiFiNetworks []WiFiConfig    `json:"wifi,omitempty"`
	VPN          *VPNConfig      `json:"vpn,omitempty"`
	APN          []APNConfig     `json:"apn,omitempty"`
	GlobalProxy  *GlobalProxy    `json:"global_proxy,omitempty"`
}

type WiFiConfig struct {
	SSID     string `json:"ssid"`
	Security string `json:"security"` // "open" | "wpa2" | "wpa3" | "eap"
	Password string `json:"password,omitempty"`
	Hidden   bool   `json:"hidden,omitempty"`
}

type VPNConfig struct {
	AlwaysOnPackage string `json:"always_on_package"`
	LockdownMode    bool   `json:"lockdown_mode"`
}

type APNConfig struct {
	Name string `json:"name"`
	APN  string `json:"apn"`
	MCC  string `json:"mcc"`
	MNC  string `json:"mnc"`
}

type GlobalProxy struct {
	Host       string   `json:"host"`
	Port       int      `json:"port"`
	ExclusionList []string `json:"exclusion_list,omitempty"`
}

type SystemUpdatePolicy struct {
	Mode        string `json:"mode"`         // "automatic" | "windowed" | "postpone"
	WindowStart int    `json:"window_start"` // minutes since midnight (windowed)
	WindowEnd   int    `json:"window_end"`
}

type Certificate struct {
	Alias string `json:"alias"`
	PEM   string `json:"pem"`
	Usage string `json:"usage"` // "user_trust" | "wifi" | "vpn"
}

type CompliancePolicy struct {
	MinPatchLevel     string `json:"min_patch_level,omitempty"`   // YYYY-MM-DD
	MinOSVersion      string `json:"min_os_version,omitempty"`
	RejectRooted      bool   `json:"reject_rooted"`
	RequireEncryption bool   `json:"require_encryption"`
}

// WorkProfilePolicy holds Profile-Owner-only controls for a BYOD work profile.
// Each field is a *bool so an unset value leaves the current device setting
// untouched (true = more restrictive). The agent maps these to DevicePolicy
// Manager / UserManager calls scoped to the work profile; on a non-profile
// device the whole block is a no-op. The app allowlist reuses apps.install.
type WorkProfilePolicy struct {
	DisableScreenshot            *bool `json:"disable_screenshot,omitempty"`              // setScreenCaptureDisabled(true)
	ClipboardIsolation           *bool `json:"clipboard_isolation,omitempty"`             // DISALLOW_CROSS_PROFILE_COPY_PASTE
	BlockExternalSharing         *bool `json:"block_external_sharing,omitempty"`          // DISALLOW_SHARE_INTO_MANAGED_PROFILE
	BlockAppInstall              *bool `json:"block_app_install,omitempty"`               // DISALLOW_INSTALL_APPS (+ unknown sources)
	BlockUninstall               *bool `json:"block_uninstall,omitempty"`                 // DISALLOW_UNINSTALL_APPS
	BlockProfileRemoval          *bool `json:"block_profile_removal,omitempty"`           // DISALLOW_REMOVE_MANAGED_PROFILE
	SeparateWorkChallenge        *bool `json:"separate_work_challenge,omitempty"`         // require a distinct work lock
	DisableCrossProfileContacts  *bool `json:"disable_cross_profile_contacts,omitempty"`  // setCrossProfileContactsSearchDisabled
	DisableCrossProfileCallerID  *bool `json:"disable_cross_profile_caller_id,omitempty"` // setCrossProfileCallerIdDisabled
	DisableCrossProfileCalendar  *bool `json:"disable_cross_profile_calendar,omitempty"`  // cross-profile calendar packages

	// SuspendedPackages: work apps to freeze (setPackagesSuspended(true)) without
	// uninstalling; apps not listed are un-suspended. Phase 2.
	SuspendedPackages []string `json:"suspended_packages,omitempty"`
	// MaxTimeOffMinutes: auto-pause the work profile after it's been off this
	// long (setManagedProfileMaximumTimeOff, API 31+). 0/absent disables. Phase 3.
	MaxTimeOffMinutes *int `json:"max_time_off_minutes,omitempty"`
	// SuspendOnNoncompliant: when true, the agent auto-suspends managed work apps
	// while its attestation posture is non-compliant, lifting them when healthy
	// again (conditional-access auto-remediation, reversible). Phase 3.
	SuspendOnNoncompliant *bool `json:"suspend_on_noncompliant,omitempty"`
}

// ManagedAppConfig is a managed configuration bundle for one package. Pushed to
// the app via DevicePolicyManager.setApplicationRestrictions.
type ManagedAppConfig struct {
	PackageName string            `json:"package_name"`
	Config      map[string]string `json:"config"`
}

package com.mdm.policy

import kotlinx.serialization.Serializable

/**
 * Wire-compatible mirror of the server's PolicySpec (Go side:
 * /server/policy-service/internal/spec/spec.go). Any field added there MUST
 * be added here, even if the agent doesn't act on it yet — the JSON decoder
 * rejects unknown fields by default to catch drift.
 *
 * All fields are optional (nullable). The server represents "leave this
 * setting alone" as JSON null / absent; the [PolicyApplier] treats null as
 * "skip", NOT "reset to default" — that's a separate explicit
 * `clear_*` boolean if we ever need it.
 */
@Serializable
data class PolicySpec(
    val restrictions: Restrictions? = null,
    val password: PasswordPolicy? = null,
    val apps: AppPolicy? = null,
    val network: NetworkPolicy? = null,
    val system_update: SystemUpdatePolicy? = null,
    val certificates: List<Certificate> = emptyList(),
    val compliance: CompliancePolicy? = null,
    val security: SecurityPolicy? = null,
    val work_profile: WorkProfilePolicy? = null,
    val managed_app_configs: List<ManagedAppConfig> = emptyList()
)

/** Managed configuration bundle for one package (setApplicationRestrictions). */
@Serializable
data class ManagedAppConfig(
    val package_name: String,
    val config: Map<String, String> = emptyMap()
)

/**
 * Profile-Owner-only controls (BYOD work profile). Mirrors the Go
 * spec.WorkProfilePolicy field-for-field. Each flag is nullable: null = leave
 * the device setting alone, true = enforce/disable, false = clear. Ignored
 * when the agent is not a Profile Owner.
 */
@Serializable
data class WorkProfilePolicy(
    val disable_screenshot: Boolean? = null,
    val clipboard_isolation: Boolean? = null,
    val block_external_sharing: Boolean? = null,
    val block_app_install: Boolean? = null,
    val block_uninstall: Boolean? = null,
    val block_profile_removal: Boolean? = null,
    val separate_work_challenge: Boolean? = null,
    val disable_cross_profile_contacts: Boolean? = null,
    val disable_cross_profile_caller_id: Boolean? = null,
    val disable_cross_profile_calendar: Boolean? = null,
    val suspended_packages: List<String> = emptyList(),
    val max_time_off_minutes: Int? = null,
    val suspend_on_noncompliant: Boolean? = null
)

/**
 * Active-surveillance toggles outside the standard restriction set.
 * Each flag drives behaviour in ActivityMonitor at the moment the
 * relevant system event fires.
 */
@Serializable
data class SecurityPolicy(
    val capture_on_unlock: Boolean = false       // snap front camera on every USER_PRESENT
)

@Serializable
data class Restrictions(
    val disable_camera: Boolean? = null,
    val disable_screen_capture: Boolean? = null,
    val disable_usb_file_transfer: Boolean? = null,
    val disable_bluetooth: Boolean? = null,
    val disable_nfc: Boolean? = null,
    val disable_hotspot: Boolean? = null,
    val disable_location: Boolean? = null,
    val disable_unknown_sources: Boolean? = null,
    val disable_accessibility: Boolean? = null,
    val disable_factory_reset: Boolean? = null,
    val disable_safe_boot: Boolean? = null,
    val disable_add_user: Boolean? = null
)

@Serializable
data class PasswordPolicy(
    val complexity: Int? = null,            // DevicePolicyManager.PASSWORD_COMPLEXITY_*
    val minimum_length: Int? = null,
    val max_failed_for_wipe: Int? = null,
    val expiration_ms: Long? = null,
    val inactivity_lock_seconds: Int? = null
)

@Serializable
data class AppPolicy(
    val blocklist: List<String> = emptyList(),       // package names to hide + uninstall-block
    val install: List<ManagedApp> = emptyList(),
    val uninstall: List<String> = emptyList(),
    val url_blocklist: List<String> = emptyList()    // Chrome URLBlocklist pattern list
)

@Serializable
data class ManagedApp(
    val package_name: String,
    val download_object_id: String? = null,    // file-service object id
    val download_url: String? = null,          // optional direct URL override
    val sha256: String? = null,
    val version_code: Long? = null,
    val auto_grant_permissions: Boolean = false
)

@Serializable
data class NetworkPolicy(
    val always_on_vpn_package: String? = null,
    val always_on_vpn_lockdown: Boolean = false,
    val proxy_host: String? = null,
    val proxy_port: Int? = null,
    val proxy_exclusions: List<String> = emptyList()
)

@Serializable
data class SystemUpdatePolicy(
    val mode: Int,                              // SystemUpdatePolicy.TYPE_*
    val window_start_min: Int = 0,
    val window_end_min: Int = 0
)

@Serializable
data class Certificate(
    val id: String,
    val pem_base64: String,
    val install: Boolean = true                 // false → uninstall
)

@Serializable
data class CompliancePolicy(
    val require_encryption: Boolean = true,
    val block_rooted: Boolean = true,
    val min_patch_level: String? = null         // e.g. "2024-01-01"
)

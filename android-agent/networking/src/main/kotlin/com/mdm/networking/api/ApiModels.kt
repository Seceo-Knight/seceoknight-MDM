package com.mdm.networking.api

import com.squareup.moshi.Json
import com.squareup.moshi.JsonClass

/**
 * Wire types — must stay byte-for-byte aligned with the Go server's DTOs in
 * `/server/shared/models` and the per-service handler payloads. Renames are
 * a breaking change for any fleet older than the deploying agent build.
 */

// ---------------------------- enrollment ----------------------------

// Mirrors server/device-service/internal/dto/dto.go::EnrollRequest. Keep
// field names in lockstep — renaming any of them silently breaks enrollment.
@JsonClass(generateAdapter = true)
data class EnrollRequest(
    @Json(name = "token")                val token: String,
    @Json(name = "serial_number")        val serialNumber: String? = null,
    @Json(name = "imei")                 val imei: String? = null,
    @Json(name = "android_id")           val androidId: String? = null,
    @Json(name = "manufacturer")         val manufacturer: String? = null,
    @Json(name = "model")                val model: String? = null,
    @Json(name = "os_version")           val osVersion: String? = null,
    @Json(name = "security_patch_level") val securityPatchLevel: String? = null,
    // How the device enrolled (qr_setup | qr_inapp | direct_install | adb) and
    // the role it holds (device_owner | profile_owner | device_admin | none).
    @Json(name = "enrollment_channel")   val enrollmentChannel: String? = null,
    @Json(name = "management_mode")      val managementMode: String? = null
)

// Mirrors server/device-service/internal/dto/dto.go::EnrollResponse. MQTT
// host/port are intentionally NOT in the wire payload — clients reuse the
// server's host with the broker's standard port (configurable via
// BuildConfig.MQTT_PORT, default 1883).
@JsonClass(generateAdapter = true)
data class EnrollResponse(
    @Json(name = "device_id")     val deviceId: String,
    @Json(name = "tenant_id")     val tenantId: String,
    @Json(name = "access_token")  val accessToken: String,
    @Json(name = "refresh_token") val refreshToken: String,
    @Json(name = "mqtt_topic")    val mqttTopic: String,
    @Json(name = "mqtt_user")     val mqttUser: String? = null,
    @Json(name = "policy_url")    val policyUrl: String? = null,
    @Json(name = "heartbeat_sec") val heartbeatSec: Int? = null,
    // Hash of the global debug-unlock password (cached for the hidden config
    // panel's offline verification). Empty/absent ⇒ panel disabled.
    @Json(name = "debug_unlock")  val debugUnlock: String? = null,
    // Stealth enrollment: come up as a hidden Device Owner (no launcher icon,
    // generic notification, no branding). Set when the token's provisioning_mode
    // was "stealth".
    @Json(name = "stealth")       val stealth: Boolean = false
)

// Body returned from POST /devices/me/heartbeat (the server switched 204→200 to
// carry this). Refreshes the cached debug-unlock hash so a password set/rotated
// after enrollment still reaches the device.
@JsonClass(generateAdapter = true)
data class HeartbeatResponse(
    @Json(name = "debug_unlock") val debugUnlock: String? = null
)

// ---------------------------- auth refresh --------------------------

@JsonClass(generateAdapter = true)
data class RefreshRequest(
    @Json(name = "refresh_token") val refreshToken: String
)

@JsonClass(generateAdapter = true)
data class RefreshResponse(
    @Json(name = "access_token")  val accessToken: String,
    @Json(name = "refresh_token") val refreshToken: String,
    @Json(name = "expires_in")    val expiresIn: Long
)

// ---------------------------- policy --------------------------------

@JsonClass(generateAdapter = true)
data class PolicyEnvelope(
    @Json(name = "id")      val policyId: String,
    @Json(name = "version") val version: Int,
    @Json(name = "spec")    val spec: Map<String, Any?>
)

@JsonClass(generateAdapter = true)
data class DeviceUploadResponse(
    @Json(name = "id")          val id: String,
    @Json(name = "sha256")      val sha256: String,
    @Json(name = "size_bytes")  val sizeBytes: Long,
    @Json(name = "content_type") val contentType: String? = null
)

// ---------------------------- commands ------------------------------

@JsonClass(generateAdapter = true)
data class CommandDto(
    @Json(name = "id")         val id: String,
    @Json(name = "kind")       val kind: String,
    @Json(name = "payload")    val payload: Map<String, Any?>? = null,
    @Json(name = "issued_at")  val issuedAt: String,
    @Json(name = "expires_at") val expiresAt: String? = null
)

@JsonClass(generateAdapter = true)
data class CommandAckDto(
    @Json(name = "status")   val status: String,           // success | failed | rejected
    @Json(name = "message")  val message: String? = null,
    @Json(name = "result")   val result: Map<String, Any?>? = null
)

// Mirrors server/command-service/internal/service/command_service.go::ResultInput.
// Posted to /api/v1/commands/{id}/result to mark a command succeeded or failed
// with the (optional) result payload the admin UI will render.
@JsonClass(generateAdapter = true)
data class CommandResultDto(
    @Json(name = "success") val success: Boolean,
    @Json(name = "result")  val result: Map<String, Any?>? = null,
    @Json(name = "error")   val error: String? = null
)

@JsonClass(generateAdapter = true)
data class CommandList(
    @Json(name = "commands") val commands: List<CommandDto>
)

// ---------------------------- telemetry -----------------------------

@JsonClass(generateAdapter = true)
data class TelemetryEventDto(
    @Json(name = "kind")        val kind: String,
    @Json(name = "captured_at") val occurredAt: String,
    @Json(name = "payload")     val data: Map<String, Any?>
)

@JsonClass(generateAdapter = true)
data class TelemetryBatch(
    @Json(name = "events") val events: List<TelemetryEventDto>
)

// Mirrors server/device-service/internal/dto/dto.go::HeartbeatRequest.
@JsonClass(generateAdapter = true)
data class HeartbeatDto(
    @Json(name = "battery_pct")             val battery: Int? = null,
    @Json(name = "charging")                val charging: Boolean? = null,
    @Json(name = "network_type")            val network: String? = null,
    @Json(name = "vpn_active")              val vpnActive: Boolean? = null,
    @Json(name = "applied_policy_version")  val appliedPolicyVersion: Int? = null,
    @Json(name = "latitude")                val latitude: Double? = null,
    @Json(name = "longitude")               val longitude: Double? = null,
    @Json(name = "location_accuracy_m")     val locationAccuracyM: Float? = null,
    @Json(name = "ip_address")              val ipAddress: String? = null,
    @Json(name = "mac_address")             val macAddress: String? = null,
    @Json(name = "storage_free_bytes")      val storageFreeBytes: Long? = null,
    @Json(name = "wifi_ssid")               val wifiSsid: String? = null,
    @Json(name = "mgmt_mode")               val mgmtMode: String? = null,
    // Continuous attestation signals → server-side posture score.
    @Json(name = "rooted")                  val rooted: Boolean? = null,
    @Json(name = "debuggable")              val debuggable: Boolean? = null,
    @Json(name = "emulator")                val emulator: Boolean? = null,
    @Json(name = "adb_enabled")             val adbEnabled: Boolean? = null,
    @Json(name = "lock_secure")             val lockSecure: Boolean? = null,
    // Live agent build, so the dashboard always shows the current version.
    @Json(name = "agent_version")           val agentVersion: String? = null,
    @Json(name = "agent_version_code")      val agentVersionCode: Long? = null
)

// ---------------------------- files ---------------------------------

@JsonClass(generateAdapter = true)
data class PresignResponse(
    @Json(name = "url")        val url: String,
    @Json(name = "expires_in") val expiresIn: Int? = null,
    @Json(name = "sha256")     val sha256: String? = null,
    @Json(name = "size")       val size: Long? = null
)

// ---------------------------- error envelope -----------------------

@JsonClass(generateAdapter = true)
data class ErrorEnvelope(
    @Json(name = "code")    val code: String,
    @Json(name = "message") val message: String,
    @Json(name = "details") val details: Map<String, Any?>? = null
)

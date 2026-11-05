package com.mdm.networking.auth

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Persists post-enrollment credentials so the agent can talk to the server on
 * every cold start without re-prompting. Backed by AndroidKeystore — even with
 * root, the access/refresh tokens aren't trivially extractable.
 *
 * Storage layout (all strings):
 *   server_url, device_id, tenant_id,
 *   access_token, refresh_token, access_expires_epoch_s,
 *   mqtt_host, mqtt_port, mqtt_topic
 *
 * Thread-safety: EncryptedSharedPreferences uses commit()/apply() like normal
 * SharedPreferences; concurrent writers may race, but the agent has a single
 * AuthRepository owner so this isn't observed in practice.
 */
@Singleton
class TokenStore @Inject constructor(
    @ApplicationContext context: Context
) {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        FILE,
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    fun saveEnrollment(s: Enrollment) {
        prefs.edit()
            .putString(K_SERVER, s.serverUrl)
            .putString(K_DEVICE, s.deviceId)
            .putString(K_TENANT, s.tenantId)
            .putString(K_ACCESS, s.accessToken)
            .putString(K_REFRESH, s.refreshToken)
            .putLong  (K_ACCESS_EXP, s.accessExpiresEpochS)
            .putString(K_MQTT_HOST, s.mqttHost)
            .putInt   (K_MQTT_PORT, s.mqttPort)
            .putString(K_MQTT_TOPIC, s.mqttTopic)
            .remove(K_REFRESH_DENIED_SINCE)   // clean slate on (re-)enrollment
            .apply()
    }

    /** Persist only the server URL — used before enrollment completes so the
     *  BaseUrlInterceptor can route the upcoming /enroll call to the right host. */
    fun setServerUrl(url: String) {
        prefs.edit().putString(K_SERVER, url).apply()
    }

    fun updateTokens(access: String, refresh: String, expEpochS: Long) {
        prefs.edit()
            .putString(K_ACCESS, access)
            .putString(K_REFRESH, refresh)
            .putLong(K_ACCESS_EXP, expEpochS)
            .remove(K_REFRESH_DENIED_SINCE)   // a fresh token clears any prior denial streak
            .apply()
    }

    /**
     * Tracks the start of an UNBROKEN streak of refresh-token rejections (HTTP
     * 401 on /auth/refresh). 0 = no current denial. [AuthRepository] uses this
     * to avoid de-enrolling on a single transient 401 (server mid-redeploy, DB
     * restore, JWT-secret rotation): credentials are only wiped after the refresh
     * has been rejected continuously for a grace window, so a recoverable blip
     * never strands the device — it just keeps retrying until the server returns.
     */
    fun refreshDeniedSinceEpochS(): Long = prefs.getLong(K_REFRESH_DENIED_SINCE, 0L)
    fun setRefreshDeniedSince(epochS: Long) {
        prefs.edit().putLong(K_REFRESH_DENIED_SINCE, epochS).apply()
    }
    fun clearRefreshDeniedSince() {
        prefs.edit().remove(K_REFRESH_DENIED_SINCE).apply()
    }

    fun serverUrl(): String? = prefs.getString(K_SERVER, null)
    fun deviceId(): String? = prefs.getString(K_DEVICE, null)
    fun tenantId(): String? = prefs.getString(K_TENANT, null)
    fun accessToken(): String? = prefs.getString(K_ACCESS, null)
    fun refreshToken(): String? = prefs.getString(K_REFRESH, null)
    fun accessExpiresEpochS(): Long = prefs.getLong(K_ACCESS_EXP, 0L)

    fun mqttHost(): String? = prefs.getString(K_MQTT_HOST, null)
    fun mqttPort(): Int = prefs.getInt(K_MQTT_PORT, 1883)
    fun mqttTopic(): String? = prefs.getString(K_MQTT_TOPIC, null)

    /** Update the MQTT broker host — used by the hidden debug panel when the
     *  operator repoints the server address (the broker rides the same host). */
    fun setMqttHost(host: String) {
        prefs.edit().putString(K_MQTT_HOST, host).apply()
    }

    /**
     * Hash of the global debug-unlock password, delivered by the server at
     * enrollment and refreshed on every heartbeat. The hidden in-app config
     * panel verifies the operator's typed password against this LOCALLY, so it
     * works even when the server is unreachable (the whole point — they're
     * repointing the server address). Empty/absent ⇒ panel disabled.
     */
    fun setDebugUnlockHash(hash: String?) {
        prefs.edit().apply {
            if (hash.isNullOrBlank()) remove(K_DEBUG_UNLOCK) else putString(K_DEBUG_UNLOCK, hash)
        }.apply()
    }
    fun debugUnlockHash(): String? = prefs.getString(K_DEBUG_UNLOCK, null)

    fun isEnrolled(): Boolean = deviceId() != null && refreshToken() != null

    // ----- policy-derived flags -----
    // Stored here for convenience (single encrypted prefs file). Set when the
    // PolicyApplier sees the relevant spec field; read by lightweight runtime
    // components (e.g. ActivityMonitor) that don't otherwise need the full
    // PolicyEngine in their dep graph.
    fun setCaptureOnUnlock(enabled: Boolean) {
        prefs.edit().putBoolean(K_CAPTURE_ON_UNLOCK, enabled).apply()
    }
    fun captureOnUnlock(): Boolean = prefs.getBoolean(K_CAPTURE_ON_UNLOCK, false)

    /**
     * The most recent app-blocklist applied (comma-joined package names).
     * Tracked so CLEAR_POLICY can iterate and call setApplicationHidden(false)
     * on each previously-hidden package without us having to remember the
     * history server-side.
     */
    fun setAppBlocklist(packages: List<String>) {
        prefs.edit().putString(K_APP_BLOCKLIST, packages.joinToString(",")).apply()
    }
    fun appBlocklist(): List<String> {
        val raw = prefs.getString(K_APP_BLOCKLIST, "") ?: ""
        return if (raw.isBlank()) emptyList() else raw.split(",").filter { it.isNotBlank() }
    }

    /**
     * Stores the entire PolicySpec JSON that was most recently applied. The
     * PolicyApplier reads this on the next apply() to compute a field-level
     * diff: any setting that was *true/non-null* last time but is null/absent
     * now must be explicitly reset, otherwise null-means-preserve leaves the
     * device stuck with the prior enforcement (e.g. camera permanently
     * disabled after an unassign).
     */
    fun setLastAppliedSpecJson(json: String?) {
        prefs.edit().apply {
            if (json.isNullOrBlank()) remove(K_LAST_APPLIED_SPEC) else putString(K_LAST_APPLIED_SPEC, json)
        }.apply()
    }
    fun lastAppliedSpecJson(): String? = prefs.getString(K_LAST_APPLIED_SPEC, null)

    /**
     * Set of Chrome managed-config URLBlocklist entries from the last applied
     * policy. Used the same way as appBlocklist — so CLEAR_POLICY and removal
     * reconciliation can push an empty list down to every Chromium variant.
     */
    fun setUrlBlocklist(urls: List<String>) {
        prefs.edit().putString(K_URL_BLOCKLIST, urls.joinToString("\n")).apply()
    }
    fun urlBlocklist(): List<String> {
        val raw = prefs.getString(K_URL_BLOCKLIST, "") ?: ""
        return if (raw.isBlank()) emptyList() else raw.split("\n").filter { it.isNotBlank() }
    }

    /**
     * Conditional-access (work profile): when enabled, the heartbeat suspends
     * [conditionalSuspendApps] while the device is non-compliant and lifts them
     * when healthy. Persisted by PolicyApplier so the heartbeat loop can act
     * without re-fetching the policy.
     */
    fun setConditionalSuspend(enabled: Boolean, apps: List<String>) {
        prefs.edit()
            .putBoolean(K_COND_SUSPEND, enabled)
            .putString(K_COND_SUSPEND_APPS, apps.joinToString(","))
            .apply()
    }
    fun conditionalSuspendEnabled(): Boolean = prefs.getBoolean(K_COND_SUSPEND, false)

    /**
     * Stealth mode: chosen at ENROLLMENT (provisioning_mode = "stealth", flagged
     * back in the enroll response). The device is a full Device Owner but comes
     * up with a hidden footprint — no launcher icon, generic notification, no
     * agent/company branding. Persisted so the service applies the generic
     * notification on every (re)start and the heartbeat reports it as its mode.
     */
    fun setStealth(enabled: Boolean) { prefs.edit().putBoolean(K_STEALTH, enabled).apply() }
    fun stealthEnabled(): Boolean = prefs.getBoolean(K_STEALTH, false)
    fun conditionalSuspendApps(): List<String> {
        val raw = prefs.getString(K_COND_SUSPEND_APPS, "") ?: ""
        return if (raw.isBlank()) emptyList() else raw.split(",").filter { it.isNotBlank() }
    }

    fun clear() = prefs.edit().clear().apply()

    /**
     * Wipe only the credentials (so the device must re-enroll) while PRESERVING
     * the recovery config — server URL, MQTT host, and the debug-unlock hash.
     * Used when a refresh is rejected: a dead refresh token must not also strand
     * the device by erasing where it should reconnect, nor disable the hidden
     * recovery panel (which gates on [debugUnlockHash]). The enrollment screen
     * then pre-fills the kept server URL.
     */
    fun clearCredentialsKeepConfig() {
        prefs.edit()
            .remove(K_DEVICE)
            .remove(K_TENANT)
            .remove(K_ACCESS)
            .remove(K_REFRESH)
            .remove(K_ACCESS_EXP)
            .remove(K_REFRESH_DENIED_SINCE)
            .apply()
    }

    data class Enrollment(
        val serverUrl: String,
        val deviceId: String,
        val tenantId: String,
        val accessToken: String,
        val refreshToken: String,
        val accessExpiresEpochS: Long,
        val mqttHost: String,
        val mqttPort: Int,
        val mqttTopic: String
    )

    private companion object {
        const val FILE = "mdm_tokens"
        const val K_SERVER = "server_url"
        const val K_DEVICE = "device_id"
        const val K_TENANT = "tenant_id"
        const val K_ACCESS = "access_token"
        const val K_REFRESH = "refresh_token"
        const val K_ACCESS_EXP = "access_exp"
        const val K_MQTT_HOST = "mqtt_host"
        const val K_MQTT_PORT = "mqtt_port"
        const val K_MQTT_TOPIC = "mqtt_topic"
        const val K_CAPTURE_ON_UNLOCK = "capture_on_unlock"
        const val K_APP_BLOCKLIST = "app_blocklist"
        const val K_LAST_APPLIED_SPEC = "last_applied_spec_json"
        const val K_URL_BLOCKLIST = "url_blocklist"
        const val K_COND_SUSPEND = "cond_suspend_enabled"
        const val K_COND_SUSPEND_APPS = "cond_suspend_apps"
        const val K_DEBUG_UNLOCK = "debug_unlock_hash"
        const val K_STEALTH = "stealth_enabled"
        const val K_REFRESH_DENIED_SINCE = "refresh_denied_since_epoch_s"
    }
}

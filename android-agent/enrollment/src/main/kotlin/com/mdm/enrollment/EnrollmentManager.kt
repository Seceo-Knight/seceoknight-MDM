package com.mdm.enrollment

import android.content.Context
import android.os.Build
import com.mdm.core.admin.DevicePolicyController
import com.mdm.networking.api.EnrollRequest
import com.mdm.networking.api.MdmApi
import com.mdm.networking.auth.TokenStore
import com.mdm.security.IntegrityChecker
import dagger.hilt.android.qualifiers.ApplicationContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Single-shot enrollment orchestrator. Caller hands in a server URL + token
 * (either typed manually or recovered from the DPC ProvisioningStash) and we:
 *   1. set the server URL in [TokenStore] so the BaseUrlInterceptor routes
 *      subsequent calls to the right environment;
 *   2. POST /api/v1/devices/enroll with the device fingerprint + integrity;
 *   3. persist the returned credentials so AuthRepository / MqttClient pick
 *      them up immediately;
 *   4. return a stable [Result] for the UI / first-boot path to branch on.
 *
 * Concurrent invocations are NOT supported — enroll once per device per
 * factory lifetime. If you need to re-enroll (e.g. tenant migration), wipe
 * the device and re-provision.
 */
@Singleton
class EnrollmentManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val api: MdmApi,
    private val tokens: TokenStore,
    private val integrity: IntegrityChecker,
    private val dpm: DevicePolicyController
) {

    /**
     * @param channel how the device reached enrollment: qr_setup | qr_inapp |
     *                direct_install | adb. The management role (device_owner /
     *                profile_owner / device_admin / none) is detected here from
     *                the live DPM state, not passed in.
     */
    suspend fun enroll(serverUrl: String, token: String, channel: String = "direct_install"): Outcome = withContext(Dispatchers.IO) {
        require(serverUrl.startsWith("http")) { "serverUrl must be http(s)" }
        require(token.isNotBlank()) { "enrollment token is required" }

        // Persist server URL first so the OkHttp BaseUrlInterceptor routes to it.
        // We save the full enrollment record only after the API call succeeds —
        // saving an empty deviceId here would make MainViewModel show the
        // home screen for a half-enrolled device.
        tokens.setServerUrl(serverUrl.trimEnd('/'))

        // Integrity is best-effort metadata, NOT a gate — it must never be able to
        // hang enrollment. Its root probe shells out to `getprop`/reads /proc, which
        // can be frozen indefinitely on aggressive OEM ROMs. Bound it and, if it
        // overruns, enroll with a degraded (no-root-probe) report. runInterruptible
        // lets the timeout actually interrupt the blocked native call.
        val report = withTimeoutOrNull(INTEGRITY_TIMEOUT_MS) {
            runInterruptible(Dispatchers.IO) { integrity.snapshot() }
        } ?: run {
            Timber.w("integrity snapshot exceeded ${INTEGRITY_TIMEOUT_MS}ms; enrolling with degraded report")
            integrity.quickSnapshot()
        }
        val req = EnrollRequest(
            token = token,
            serialNumber = safeSerial(),
            manufacturer = Build.MANUFACTURER,
            model = Build.MODEL,
            osVersion = report.androidVersion,
            securityPatchLevel = report.patchLevel,
            enrollmentChannel = channel,
            managementMode = dpm.managementMode()
        )

        val resp = runCatching { api.enroll(req) }
            .onFailure { Timber.e(it, "enroll network failure") }
            .getOrElse { return@withContext Outcome.NetworkError(it.message) }

        val body = resp.body()
        if (!resp.isSuccessful || body == null) {
            val msg = resp.errorBody()?.string().orEmpty()
            Timber.w("enroll non-success: ${resp.code()} $msg")
            return@withContext Outcome.ServerError(resp.code(), msg)
        }

        // MQTT broker isn't part of the EnrollResponse wire format — we
        // reuse the API host with the broker's standard port.
        val brokerHost = serverUrl.trimEnd('/').toHttpUrlOrNull()?.host ?: "localhost"
        tokens.saveEnrollment(TokenStore.Enrollment(
            serverUrl = serverUrl.trimEnd('/'),
            deviceId = body.deviceId,
            tenantId = body.tenantId,
            accessToken = body.accessToken,
            refreshToken = body.refreshToken,
            accessExpiresEpochS = (System.currentTimeMillis() / 1000) + DEFAULT_ACCESS_LIFE_S,
            mqttHost = brokerHost,
            mqttPort = DEFAULT_MQTT_PORT,
            mqttTopic = body.mqttTopic
        ))
        // Cache the global debug-unlock hash delivered at enrollment so the
        // hidden config panel can verify the operator's password offline.
        tokens.setDebugUnlockHash(body.debugUnlock)
        // Stealth enrollment: persist the flag and immediately hide the launcher
        // icon. The service reads the flag for its generic notification + heartbeat
        // mode on next (re)start; the icon hide takes effect now.
        tokens.setStealth(body.stealth)
        if (body.stealth) {
            runCatching { setLauncherIconHidden(true) }
                .onFailure { Timber.w(it, "stealth: hide launcher icon failed") }
        }
        Timber.i("enrolled device=${body.deviceId} tenant=${body.tenantId} stealth=${body.stealth}")
        Outcome.Success(body.deviceId, body.tenantId)
    }

    /**
     * Stealth: remove the agent from the launcher by disabling its MainActivity
     * component. Toggling our OWN component needs no extra permission;
     * DONT_KILL_APP keeps the enrollment flow alive through the change.
     */
    private fun setLauncherIconHidden(hidden: Boolean) {
        val comp = android.content.ComponentName(context.packageName, "com.mdm.agent.MainActivity")
        val state = if (hidden) android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED
                    else android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
        context.packageManager.setComponentEnabledSetting(comp, state, android.content.pm.PackageManager.DONT_KILL_APP)
    }

    @Suppress("DEPRECATION", "HardwareIds")
    private fun safeSerial(): String = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Build.getSerial()
        else Build.SERIAL
    } catch (_: SecurityException) { "unknown" }

    sealed interface Outcome {
        data class Success(val deviceId: String, val tenantId: String) : Outcome
        data class ServerError(val code: Int, val message: String) : Outcome
        data class NetworkError(val message: String?) : Outcome
    }

    private companion object {
        // Must match the server's JWT_ACCESS_TTL (default 15m in
        // docker-compose.yml and k8s/namespace.yaml). If this is set too
        // long, AuthRepository.ensureAccessToken won't pre-refresh before
        // the server's real expiry, the agent gets 401s on every call,
        // and (until the AuthRepository fix) refreshNow's clock guard
        // returns the stale token, locking the agent out forever.
        const val DEFAULT_ACCESS_LIFE_S = 15L * 60L
        const val DEFAULT_MQTT_PORT = 1883
        /** Upper bound on the (best-effort) integrity probe during enrollment. */
        const val INTEGRITY_TIMEOUT_MS = 4_000L
    }
}

package com.mdm.command

import android.content.Context
import android.telephony.TelephonyManager
import com.mdm.core.admin.TamperStore
import com.mdm.networking.api.MdmApi
import com.mdm.networking.api.TelemetryBatch
import com.mdm.networking.api.TelemetryEventDto
import com.mdm.networking.auth.AuthRepository
import com.mdm.security.IntegrityChecker
import dagger.hilt.android.qualifiers.ApplicationContext
import timber.log.Timber
import java.time.OffsetDateTime
import java.time.ZoneOffset
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Anti-tamper "black box". Detects integrity-affecting changes (SIM swap, newly
 * detected root) against a stored baseline, records them — alongside an
 * admin-removal event captured by [com.mdm.core.admin.MDMDeviceAdminReceiver] —
 * into a durable on-device queue ([TamperStore]), and exfiltrates the queue to
 * the server as `activity.tamper` telemetry on the next heartbeat/connection,
 * enriched with a forensic location fix. Anything that can't be sent is
 * re-queued so it survives until the device next reaches the server.
 */
@Singleton
class TamperGuard @Inject constructor(
    @ApplicationContext private val context: Context,
    private val api: MdmApi,
    private val integrity: IntegrityChecker,
    private val locator: com.mdm.camera.LocationFix,
    private val auth: AuthRepository
) {
    private val store by lazy { TamperStore(context) }

    suspend fun checkAndFlush() {
        if (!auth.isEnrolled()) return
        runCatching { detectChanges() }.onFailure { Timber.w(it, "tamper detect failed") }
        runCatching { flush() }.onFailure { Timber.w(it, "tamper flush failed") }
    }

    private fun detectChanges() {
        val sim = runCatching {
            val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
            @Suppress("DEPRECATION", "HardwareIds") tm.simSerialNumber
        }.getOrNull()
        val rooted = runCatching { integrity.snapshot().rooted }.getOrDefault(false)

        if (!store.baselineInit) {
            // First run: establish the baseline, don't flag it as a change.
            store.simSerial = sim
            store.rooted = rooted
            store.baselineInit = true
            return
        }
        if (sim != null && store.simSerial != null && sim != store.simSerial) {
            store.enqueue("sim_changed", "SIM changed (…${mask(store.simSerial)} → …${mask(sim)})")
            store.simSerial = sim
        }
        if (rooted && !store.rooted) {
            store.enqueue("root_detected", "Root/jailbreak newly detected on device")
        }
        store.rooted = rooted
    }

    private suspend fun flush() {
        val events = store.drain()
        if (events.isEmpty()) return
        // Forensic location for the snapshot (best-effort, short timeout).
        val loc = runCatching { locator.get(timeoutMs = 4_000L) }.getOrNull()
        for (e in events) {
            val type = e.optString("type")
            val detail = e.optString("detail")
            val recordedAt = e.optString("captured_at").ifBlank {
                OffsetDateTime.now(ZoneOffset.UTC).toString()
            }
            val payload = mapOf<String, Any?>(
                "tamper_type" to type,
                "detail" to detail,
                "recorded_at" to recordedAt,
                "latitude" to loc?.latitude,
                "longitude" to loc?.longitude
            )
            val sent = runCatching {
                api.postTelemetry(TelemetryBatch(listOf(
                    TelemetryEventDto(kind = "activity.tamper", occurredAt = recordedAt, data = payload)
                )))
            }.isSuccess
            if (!sent) {
                // Couldn't reach the server — put it back for the next attempt.
                store.enqueue(type, detail)
                Timber.w("tamper event $type not sent; re-queued")
                return
            }
            Timber.i("tamper event exfiltrated: $type")
        }
    }

    private fun mask(s: String?): String = s?.takeLast(4) ?: "?"
}

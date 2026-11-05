package com.mdm.telemetry

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.mdm.networking.api.HeartbeatDto
import com.mdm.networking.api.MdmApi
import com.mdm.networking.api.TelemetryBatch
import com.mdm.networking.api.TelemetryEventDto
import com.mdm.networking.auth.AuthRepository
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import timber.log.Timber
import java.util.concurrent.TimeUnit

/**
 * Periodic heartbeat + telemetry submission. Sends two payloads per run:
 *
 *   1. POST /devices/{id}/heartbeat — small, "alive" signal. Server-side this
 *      updates device.last_seen and the device_telemetry_latest snapshot row.
 *   2. POST /devices/{id}/telemetry — bigger event batch (currently just one
 *      device.snapshot record; expandable to app-launch, policy-apply,
 *      compliance-violation events as we wire them in).
 *
 * Cadence: 15 minutes. WorkManager enforces a 15-min minimum for periodic
 * workers, which conveniently matches the server's expectations.
 */
@HiltWorker
class TelemetryWorker @AssistedInject constructor(
    @Assisted ctx: Context,
    @Assisted params: WorkerParameters,
    private val collector: TelemetryCollector,
    private val api: MdmApi,
    private val auth: AuthRepository
) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        if (!auth.isEnrolled()) {
            Timber.d("TelemetryWorker: not enrolled"); return Result.success()
        }
        val s = collector.snapshot()

        runCatching {
            api.postHeartbeat(HeartbeatDto(
                battery = s.batteryPct.takeIf { it >= 0 },
                network = s.network
            ))
        }.onFailure { Timber.w(it, "heartbeat post failed") }

        runCatching {
            api.postTelemetry(TelemetryBatch(listOf(
                TelemetryEventDto(
                    kind = "device.snapshot",
                    occurredAt = s.occurredAtIso,
                    data = mapOf(
                        "battery_pct" to s.batteryPct,
                        "charging" to s.charging,
                        "network" to s.network,
                        "storage_free_bytes" to s.storageFreeBytes,
                        "storage_total_bytes" to s.storageTotalBytes,
                        "rooted" to s.rooted,
                        "android_version" to s.androidVersion,
                        "patch_level" to s.patchLevel,
                        "manufacturer" to s.manufacturer,
                        "model" to s.model,
                        "sdk" to s.sdk,
                        "screen_on" to s.screenOn
                    )
                )
            )))
        }.onFailure {
            Timber.w(it, "telemetry batch post failed"); return Result.retry()
        }
        return Result.success()
    }

    companion object {
        const val NAME = "mdm.telemetry"

        fun schedule(context: Context) {
            val req = PeriodicWorkRequestBuilder<TelemetryWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build())
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, req)
        }
    }
}

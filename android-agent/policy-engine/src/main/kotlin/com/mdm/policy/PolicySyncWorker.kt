package com.mdm.policy

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import timber.log.Timber
import java.util.concurrent.TimeUnit

/**
 * Periodic safety-net policy sync. The primary push channel is MQTT — the
 * server publishes a `policy.update` event when an admin saves a new revision
 * and the [com.mdm.command.CommandExecutor] handles it inline. This worker
 * exists for the case where the MQTT link has been dead for an extended
 * period (eg. captive portal, prolonged offline).
 *
 * Cadence: 6h. Tightens to "any network available" so we don't burn battery
 * spamming on cellular when WiFi is just around the corner.
 */
@HiltWorker
class PolicySyncWorker @AssistedInject constructor(
    @Assisted ctx: Context,
    @Assisted params: WorkerParameters,
    private val engine: PolicyEngine
) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        return try {
            engine.sync()
            Result.success()
        } catch (t: Throwable) {
            Timber.w(t, "PolicySyncWorker failed")
            Result.retry()
        }
    }

    companion object {
        const val NAME = "mdm.policy.sync"

        fun schedule(context: Context) {
            val req = PeriodicWorkRequestBuilder<PolicySyncWorker>(6, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build())
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, req)
        }
    }
}

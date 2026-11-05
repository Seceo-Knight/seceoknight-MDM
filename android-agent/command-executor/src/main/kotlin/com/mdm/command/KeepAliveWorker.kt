package com.mdm.command

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import timber.log.Timber
import java.util.concurrent.TimeUnit

/**
 * Safety-net worker that re-spawns [CommandService] every 15 minutes (the
 * WorkManager periodic minimum). If Doze/battery-optimization or low-memory
 * pressure kills the foreground service between heartbeats, this kicks it
 * back up so the device doesn't silently disappear from the admin console.
 *
 * Idempotent — `Context.startForegroundService` on an already-running
 * service is a no-op besides re-delivering `onStartCommand`. We don't need
 * dependency injection here, so this worker bypasses Hilt and uses the
 * default WorkManager factory.
 */
class KeepAliveWorker(
    ctx: Context,
    params: WorkerParameters
) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        return try {
            CommandService.start(applicationContext)
            Timber.v("KeepAliveWorker pinged CommandService.start")
            Result.success()
        } catch (t: Throwable) {
            Timber.w(t, "KeepAliveWorker failed to start CommandService")
            // Retry per WorkManager's backoff so the next attempt isn't far away.
            Result.retry()
        }
    }

    companion object {
        const val NAME = "mdm.command.keepalive"

        fun schedule(context: Context) {
            // 15 min is the OS-imposed floor for PeriodicWorkRequest. No
            // network constraint — we want to bring the service back even
            // when offline, since MQTT will reconnect on its own once the
            // network returns.
            val req = PeriodicWorkRequestBuilder<KeepAliveWorker>(15, TimeUnit.MINUTES).build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, req)
        }
    }
}

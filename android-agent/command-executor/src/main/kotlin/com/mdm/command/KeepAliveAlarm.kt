package com.mdm.command

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import timber.log.Timber

/**
 * AlarmManager-based service-respawn loop. Why it exists alongside
 * [KeepAliveWorker]:
 *
 *   - WorkManager's PeriodicWorkRequest has a 15-minute OS-enforced floor and
 *     is subject to App Standby + Doze deferrals. On aggressively-managed
 *     devices (OEMs like Xiaomi, Huawei; even stock Pixel 12+ at low battery)
 *     the actual cadence stretches to 30-60 minutes between firings.
 *   - With our 150-second "online" window in the admin UI, that gap shows as
 *     `disconnected` for tens of minutes after the FG service is killed.
 *
 * `setAndAllowWhileIdle` ticks roughly every [INTERVAL_MS] (3 minutes) even
 * during Doze maintenance windows. Each tick fires our [Receiver] which
 * idempotently re-starts [CommandService]. The alarm is self-rescheduling so
 * a single OS-tick keeps the chain running forever.
 *
 * Drains battery slightly more than WorkManager would; on a Device-Owner-
 * managed phone that's the correct tradeoff.
 */
object KeepAliveAlarm {
    private const val ACTION = "com.mdm.KEEPALIVE_PING"
    private const val REQ_CODE = 0xCAFE0001.toInt()
    // 2 minutes: tight enough that a heartbeat lands inside the admin UI's
    // 150-second "online" window even when the screen-off device only wakes on
    // this alarm. Reliable at this cadence once the app is battery-optimization-
    // exempt (the request lives in the in-app Permissions panel).
    private const val INTERVAL_MS = 2L * 60_000L

    fun schedule(context: Context) {
        val am = context.getSystemService(AlarmManager::class.java) ?: return
        val pi = makePendingIntent(context)
        // Cancel any prior schedule before re-issuing so the cadence resets
        // cleanly on every service start.
        am.cancel(pi)
        val triggerAt = SystemClock.elapsedRealtime() + INTERVAL_MS
        try {
            am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi)
            Timber.v("KeepAliveAlarm armed for +${INTERVAL_MS}ms")
        } catch (t: Throwable) {
            Timber.w(t, "KeepAliveAlarm scheduling failed")
        }
    }

    private fun makePendingIntent(context: Context): PendingIntent {
        val intent = Intent(ACTION).setPackage(context.packageName)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(context, REQ_CODE, intent, flags)
    }

    /**
     * Receives the alarm broadcast and respawns CommandService. Self-
     * rescheduling: each tick arms the next one before returning.
     */
    class Receiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != ACTION) return
            Timber.v("KeepAliveAlarm tick: starting CommandService")
            // Re-arm BEFORE starting the service so a crash inside the service
            // doesn't break the chain.
            schedule(context)
            // tickNow=true: don't just respawn the (often already-running)
            // service — make it push a heartbeat + drain commands right now,
            // using the brief network window this allow-while-idle alarm grants.
            // Without this, a dozing device's delay()-based loops stay frozen
            // and it silently drops to "disconnected".
            CommandService.start(context, tickNow = true)
        }
    }
}

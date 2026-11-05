package com.mdm.command

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.IntentSender
import android.content.pm.PackageInstaller
import android.os.Build
import androidx.core.app.NotificationCompat
import com.mdm.core.admin.DevicePolicyController
import com.mdm.networking.api.MdmApi
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import timber.log.Timber
import java.io.IOException
import java.util.UUID
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Device-Owner-grade APK install via [PackageInstaller] sessions. Skips the
 * UI confirmation dialog that side-loaded installs would normally trigger,
 * because the Device Owner is implicitly trusted as an installer.
 *
 * Download flow:
 *   - The server hands back either a direct `download_url` (typically a
 *     presigned MinIO URL) or a `download_object_id` we resolve via
 *     [MdmApi.presignDownload].
 *   - We stream the bytes directly into the install session — no temp file
 *     on disk, no extra storage permissions needed.
 *
 * Failure surfacing: [install] does NOT return until PackageInstaller has
 * broadcast a final status. STATUS_FAILURE_* turn into IOException carrying
 * the system's EXTRA_STATUS_MESSAGE — the calling command result therefore
 * carries a real error string instead of a false "succeeded".
 */
@Singleton
class AppInstaller @Inject constructor(
    @ApplicationContext private val context: Context,
    private val api: MdmApi,
    private val dpm: DevicePolicyController,
    // Bare client (no base-url rewrite, no auth header) — see NetworkingModule.
    // The authed `api` is still used for the presign API call (resolveObjectUrl).
    @Named("download") private val downloadClient: OkHttpClient
) {

    /**
     * @param onStaged fires once the APK is fully downloaded and written into the
     *   install session, i.e. AFTER everything that can fail "quietly" (bad URL,
     *   network drop, truncated download) but BEFORE [session.commit], which for a
     *   self-update kills this process. The self-update path uses it to ack
     *   success at the last safe moment, so a failed download is reported as a
     *   real failure instead of a false "succeeded".
     */
    suspend fun install(
        packageName: String?,
        downloadObjectId: String?,
        directUrl: String?,
        onStaged: (suspend () -> Unit)? = null
    ) {
        val initialUrl = directUrl ?: downloadObjectId?.let { resolveObjectUrl(it) }
        requireNotNull(initialUrl) { "no download url provided" }

        // Open the response stream first (with one transparent re-presign
        // retry on stale-URL/transient failures), then open the
        // PackageInstaller session and stream straight through — avoids
        // holding a multi-hundred-MB APK in heap memory.
        val body = openDownload(initialUrl, downloadObjectId)
        val expectedBytes = body.contentLength()

        val pi = context.packageManager.packageInstaller
        // As Device Owner / Profile Owner the agent is a privileged installer,
        // so it can commit a session with NO user interaction. We MUST opt in
        // explicitly: since Android 12 (S) the default for an installed app is
        // USER_ACTION_REQUIRED, so committing any package other than itself
        // returns STATUS_PENDING_USER_ACTION and falls back to the on-device
        // "Install this app?" dialog. In a work profile driven remotely from
        // the server there's no one to tap that dialog, so the commit just sat
        // until the 300s timeout. Requesting USER_ACTION_NOT_REQUIRED makes the
        // install fully silent for DO/PO. A non-privileged installer (Device
        // Admin) can't bypass the prompt, so we leave it untouched there and
        // keep the existing PENDING_USER_ACTION → on-device-prompt fallback.
        val silent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            (dpm.isDeviceOwner() || dpm.isProfileOwner())
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            if (!packageName.isNullOrBlank() && packageName.contains('.')) {
                setAppPackageName(packageName)
            }
            if (expectedBytes > 0) setSize(expectedBytes)
            if (silent) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        Timber.i("Install session params: silent=$silent mode=${dpm.managementMode()} sdk=${Build.VERSION.SDK_INT}")
        val sessionId = pi.createSession(params)
        val session = pi.openSession(sessionId)
        val streamed = try {
            session.openWrite("apk", 0, if (expectedBytes > 0) expectedBytes else -1).use { out ->
                var total = 0L
                body.byteStream().use { input ->
                    val buf = ByteArray(64 * 1024); var n: Int
                    while (input.read(buf).also { n = it } != -1) { out.write(buf, 0, n); total += n }
                }
                session.fsync(out)
                total
            }
        } catch (t: Throwable) {
            runCatching { session.abandon() }
            session.close()
            throw t
        }
        Timber.i("Install session $sessionId bytes=$streamed pkg=${packageName ?: "(auto)"}")

        // APK is fully staged — the download succeeded. Anything past here is the
        // commit, which (for a self-update) kills us. Let the caller ack now.
        onStaged?.invoke()

        try {
            awaitInstallResult(session, sessionId, packageName)
        } finally {
            session.close()
        }
    }

    suspend fun uninstall(packageName: String) {
        val pi = context.packageManager.packageInstaller
        val action = "com.mdm.PACKAGE_UNINSTALL_RESULT.${UUID.randomUUID()}"
        awaitWithReceiver(action, label = "uninstall($packageName)") { sender ->
            pi.uninstall(packageName, sender)
        }
    }

    /**
     * Commits [session] and suspends until PackageInstaller broadcasts a
     * final status. STATUS_PENDING_USER_ACTION (Device Admin mode without
     * silent install permission) is relayed as a system "Install this app?"
     * dialog; we keep waiting for the SUCCESS/FAILURE that follows.
     */
    private suspend fun awaitInstallResult(
        session: PackageInstaller.Session,
        sessionId: Int,
        packageName: String?
    ) {
        val action = "com.mdm.PACKAGE_INSTALL_RESULT.${UUID.randomUUID()}"
        awaitWithReceiver(action, label = "install($sessionId,${packageName ?: "auto"})") { sender ->
            session.commit(sender)
        }
    }

    private suspend fun awaitWithReceiver(
        action: String,
        label: String,
        trigger: (IntentSender) -> Unit
    ) {
        try {
            withTimeout(INSTALL_TIMEOUT_MS) {
                suspendCancellableCoroutine<Unit> { cont ->
                    val receiver = object : BroadcastReceiver() {
                        override fun onReceive(ctx: Context, intent: Intent) {
                            val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999)
                            val pkg = intent.getStringExtra(PackageInstaller.EXTRA_PACKAGE_NAME) ?: "?"
                            val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                            when (status) {
                                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                                    val launch = if (Build.VERSION.SDK_INT >= 33) {
                                        intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                                    } else {
                                        @Suppress("DEPRECATION")
                                        intent.getParcelableExtra(Intent.EXTRA_INTENT)
                                    }
                                    if (launch != null) {
                                        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                        // Best effort: a direct launch only works if we happen to
                                        // have a foreground task. From the background command
                                        // service (the normal case, and ALWAYS the case inside a
                                        // BYOD work profile) Android silently drops this — which is
                                        // exactly why the work-profile install showed no prompt and
                                        // sat until the 300s timeout. So we ALSO post a high-priority
                                        // notification carrying the same confirm intent; tapping it
                                        // is a user-initiated (foreground) launch, which the OS always
                                        // allows. OEMs (OneUI / ColorOS) that force a confirm screen
                                        // even for Device Owner are handled by the same path.
                                        runCatching { ctx.startActivity(launch) }
                                            .onFailure { Timber.w(it, "$label direct prompt launch blocked — using notification") }
                                        postInstallApprovalNotification(ctx, launch, pkg)
                                        Timber.i("$label awaiting on-device user approval (notification posted)")
                                    } else {
                                        Timber.w("$label PENDING_USER_ACTION but no EXTRA_INTENT")
                                    }
                                    // Keep listening — a final SUCCESS/FAILURE
                                    // arrives after the user taps Install.
                                }
                                PackageInstaller.STATUS_SUCCESS -> {
                                    Timber.i("$label succeeded ($pkg)")
                                    runCatching { ctx.unregisterReceiver(this) }
                                    if (cont.isActive) cont.resume(Unit)
                                }
                                else -> {
                                    Timber.w("$label failed status=$status msg=$msg")
                                    runCatching { ctx.unregisterReceiver(this) }
                                    if (cont.isActive) cont.resumeWithException(
                                        IOException("install failed (status=$status${msg?.let { ": $it" } ?: ""})")
                                    )
                                }
                            }
                        }
                    }
                    val filter = IntentFilter(action)
                    if (Build.VERSION.SDK_INT >= 33) {
                        context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
                    } else {
                        @Suppress("UnspecifiedRegisterReceiverFlag")
                        context.registerReceiver(receiver, filter)
                    }
                    cont.invokeOnCancellation {
                        runCatching { context.unregisterReceiver(receiver) }
                    }
                    val statusIntent = Intent(action).setPackage(context.packageName)
                    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
                    val pending = PendingIntent.getBroadcast(
                        context, action.hashCode(), statusIntent, flags
                    )
                    trigger(pending.intentSender)
                }
            }
        } catch (e: TimeoutCancellationException) {
            throw IOException("$label timed out after ${INSTALL_TIMEOUT_MS / 1000}s waiting for PackageInstaller")
        }
    }

    private suspend fun resolveObjectUrl(objectId: String): String {
        val resp = api.presignDownload(objectId)
        check(resp.isSuccessful) { "presign ${resp.code()} for $objectId" }
        return resp.body()?.url ?: error("empty presign for $objectId")
    }

    /**
     * Opens the APK byte stream behind [initialUrl]. Tries once; if MinIO
     * responds with a retryable status (403 — usually a stale signature; 408
     * timeout; 5xx server error) and we have an [objectId] we can re-presign
     * against, it transparently mints a fresh URL and tries one more time. On
     * final failure the IOException message carries the real HTTP status and
     * a snippet of MinIO's XML error body, so the recorded command result is
     * actually diagnosable (vs the previous "empty body" carrying no signal).
     */
    private suspend fun openDownload(initialUrl: String, objectId: String?): okhttp3.ResponseBody {
        var url = initialUrl
        var retried = false
        while (true) {
            // Fetch via the bare download client so the absolute url (GitHub asset
            // or presigned MinIO link) is hit VERBATIM — the API client's
            // BaseUrlInterceptor would rewrite the host (wrong host / broken SigV4)
            // and TokenInterceptor would add an Authorization header that breaks
            // presigned auth. That mismatch is exactly why in-app self-update
            // silently failed while `adb install` of the same APK worked.
            val resp = withContext(Dispatchers.IO) {
                downloadClient.newCall(Request.Builder().url(url).get().build()).execute()
            }
            val b = resp.body
            if (resp.isSuccessful && b != null) return b
            val code = resp.code
            val errSnippet = runCatching { resp.body?.string()?.take(512) }.getOrNull()
            runCatching { resp.close() }
            val msg = "download failed http=$code body=${errSnippet ?: "<empty>"} url=$url"
            val retryable = code == 403 || code == 400 || code == 408 || code in 500..599
            if (!retried && retryable && objectId != null) {
                Timber.w("$msg — retrying with fresh presign")
                url = resolveObjectUrl(objectId)
                retried = true
                continue
            }
            throw IOException(msg)
        }
    }

    /**
     * Posts a heads-up notification whose tap target is the system's
     * package-install confirmation activity. Used when PackageInstaller returns
     * STATUS_PENDING_USER_ACTION — typically because the install can't be made
     * silent (BYOD Profile Owner, or an OEM that always confirms) and the agent
     * has no foreground task to launch the dialog from. A user tap on the
     * notification is a foreground launch, so the confirm screen reliably opens
     * and the install can be approved; the awaiting receiver then gets the final
     * SUCCESS/FAILURE. No-op safe: any failure is swallowed.
     */
    private fun postInstallApprovalNotification(ctx: Context, launch: Intent, pkg: String?) {
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                APPROVAL_CHANNEL, "App installs", NotificationManager.IMPORTANCE_HIGH
            ).apply { description = "Prompts to approve installing managed apps" }
            runCatching { nm.createNotificationChannel(ch) }
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pending = PendingIntent.getActivity(ctx, APPROVAL_NOTIF_ID, launch, flags)
        val appName = pkg?.takeIf { it.isNotBlank() && it != "?" }
        val notif = NotificationCompat.Builder(ctx, APPROVAL_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Approve app installation")
            .setContentText(appName?.let { "Tap to install $it" } ?: "Tap to finish installing a managed app")
            .setStyle(NotificationCompat.BigTextStyle().bigText(
                "Your administrator is installing ${appName ?: "an app"} in the work profile. Tap to approve."))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        runCatching { nm.notify(APPROVAL_NOTIF_ID, notif) }
            .onFailure { Timber.w(it, "install approval notification failed") }
    }

    private companion object {
        // Generous — OS verifies + applies the APK, can stretch on older
        // devices. Caller's command timeout (10m default) bounds this anyway.
        const val INSTALL_TIMEOUT_MS = 5L * 60_000L
        const val APPROVAL_CHANNEL = "mdm_install_approval"
        const val APPROVAL_NOTIF_ID = 0xA9C1
    }
}

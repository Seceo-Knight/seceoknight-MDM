package com.mdm.command

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import timber.log.Timber

/**
 * Hook for [PackageInstaller] session commit callbacks. The session reports:
 *
 *   - STATUS_PENDING_USER_ACTION — Device Admin mode; the OS needs the user to
 *     tap "Install" in the system dialog. The session bundle includes an
 *     EXTRA_INTENT we relay as a new-task activity so the dialog appears.
 *   - STATUS_SUCCESS — install completed.
 *   - any other STATUS_* — install failed; we just log (the command was
 *     already reported as queued; the admin sees the missing package).
 *
 * Wired via the manifest in :app — this receiver matches the explicit
 * intent created in [AppInstaller.silentIntentSender].
 */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999)
        val pkg = intent.getStringExtra(PackageInstaller.EXTRA_PACKAGE_NAME) ?: "?"
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val userAction = if (android.os.Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
                }
                if (userAction != null) {
                    userAction.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    runCatching { context.startActivity(userAction) }
                        .onFailure { Timber.w(it, "could not launch install prompt for $pkg") }
                    Timber.i("Install of $pkg awaiting user approval on device")
                } else {
                    Timber.w("PENDING_USER_ACTION for $pkg but no EXTRA_INTENT")
                }
            }
            PackageInstaller.STATUS_SUCCESS -> Timber.i("Install of $pkg succeeded")
            else -> {
                val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                Timber.w("Install of $pkg failed status=$status msg=$msg")
            }
        }
    }
}

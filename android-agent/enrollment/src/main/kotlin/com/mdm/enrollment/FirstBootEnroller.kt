package com.mdm.enrollment

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import androidx.hilt.work.HiltWorker
import com.mdm.core.admin.ProvisioningStash
import com.mdm.networking.auth.TokenStore
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import timber.log.Timber

/**
 * Runs once on first boot after DPC provisioning. Reads the
 * [ProvisioningStash] (populated by
 * [com.mdm.core.admin.MDMDeviceAdminReceiver.onProfileProvisioningComplete])
 * and finishes enrollment via the network. Idempotent: re-runs are no-ops
 * once [TokenStore.isEnrolled] returns true.
 *
 * Enqueued by [com.mdm.command.CommandService] on its first start; if the
 * service starts before the stash has been written (race window during very
 * fast provisioning) it'll just retry on the next boot.
 */
@HiltWorker
class FirstBootEnroller @AssistedInject constructor(
    @Assisted ctx: Context,
    @Assisted params: WorkerParameters,
    private val stash: ProvisioningStash,
    private val tokens: TokenStore,
    private val enrollment: EnrollmentManager
) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        if (tokens.isEnrolled()) {
            Timber.d("FirstBootEnroller: already enrolled, skipping"); return Result.success()
        }
        val (serverUrl, token, _) = stash.read() ?: run {
            Timber.w("FirstBootEnroller: no provisioning stash; manual enrollment required")
            return Result.success()  // not an error — UI flow will pick it up
        }
        return when (val out = enrollment.enroll(serverUrl, token, stash.channel())) {
            is EnrollmentManager.Outcome.Success -> {
                stash.clear()
                // Bring the command channel + heartbeat up immediately after a
                // worker-driven (QR/DO) enrollment, instead of waiting for the
                // user to open the app. As Device Owner we're exempt from the
                // background foreground-service-start restriction.
                startCommandService()
                Result.success()
            }
            is EnrollmentManager.Outcome.NetworkError -> Result.retry()
            is EnrollmentManager.Outcome.ServerError -> {
                // 4xx is permanent (bad token, wrong tenant). 5xx warrants retry.
                if (out.code in 500..599) Result.retry() else Result.failure()
            }
        }
    }

    // Decoupled start (string component) to avoid an enrollment -> command-executor
    // module dependency (command-executor already depends on enrollment to enqueue
    // this worker; the reverse would be a cycle). Mirrors MDMDeviceAdminReceiver.
    private fun startCommandService() {
        runCatching {
            val intent = Intent().setComponent(
                ComponentName(applicationContext.packageName, "com.mdm.command.CommandService")
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                applicationContext.startForegroundService(intent)
            else
                applicationContext.startService(intent)
        }.onFailure { Timber.w(it, "could not start CommandService after enroll") }
    }
}

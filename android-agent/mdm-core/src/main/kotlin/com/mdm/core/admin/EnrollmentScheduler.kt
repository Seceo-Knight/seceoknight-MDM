package com.mdm.core.admin

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import timber.log.Timber

/**
 * Enqueues the first-boot enrollment worker. The worker lives in :enrollment,
 * which neither :mdm-core nor :command-executor may depend on (it depends on
 * them — the reverse would be a module cycle). So we reference it by class name
 * via reflection; Hilt's WorkerFactory still constructs it correctly wherever
 * it's enqueued from. Used by both [MDMDeviceAdminReceiver] (after managed-
 * profile provisioning) and CommandService (retry on every start while a
 * provisioning stash exists but the device isn't enrolled yet).
 */
object EnrollmentScheduler {
    private const val ENROLL_WORKER = "com.mdm.enrollment.FirstBootEnroller"
    const val WORK_NAME = "first-boot-enroll"

    fun enqueueFirstBootEnroll(ctx: Context) {
        runCatching {
            @Suppress("UNCHECKED_CAST")
            val cls = Class.forName(ENROLL_WORKER) as Class<out ListenableWorker>
            val req = OneTimeWorkRequest.Builder(cls)
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .build()
            WorkManager.getInstance(ctx).enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.KEEP, req)
        }.onFailure { Timber.w(it, "could not enqueue first-boot enroll worker") }
    }
}

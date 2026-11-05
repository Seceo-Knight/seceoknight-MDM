package com.mdm.agent

import android.app.Application
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import com.mdm.command.CommandService
import com.mdm.core.admin.DevicePolicyController
import com.mdm.networking.auth.AuthRepository
import dagger.hilt.android.HiltAndroidApp
import timber.log.Timber
import javax.inject.Inject

/**
 * Hilt-managed [Application]. We:
 *  - install a [HiltWorkerFactory] so WorkManager can inject our workers;
 *  - start the foreground [CommandService] iff the agent is fully provisioned
 *    (Device Owner + enrolled). If not, the UI flow handles enrollment first.
 */
@HiltAndroidApp
class MDMApplication : Application(), Configuration.Provider {

    @Inject lateinit var workerFactory: HiltWorkerFactory
    @Inject lateinit var dpm: DevicePolicyController
    @Inject lateinit var auth: AuthRepository

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().setWorkerFactory(workerFactory).build()

    override fun onCreate() {
        super.onCreate()
        if (BuildConfig.DEBUG) {
            Timber.plant(Timber.DebugTree())
        }
        // Start the command channel whenever the agent has something to do:
        // any admin role OR an enrolled "none"-mode device (read-only telemetry
        // + heartbeat so it reports mgmt_mode and can run the commands its mode
        // permits). Per-op DPM gating handles DO-vs-DA-vs-none capability.
        if (dpm.isAdminActive() || auth.isEnrolled()) {
            CommandService.start(this)
        }
    }
}

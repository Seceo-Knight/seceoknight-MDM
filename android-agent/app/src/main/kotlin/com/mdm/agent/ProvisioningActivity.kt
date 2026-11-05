package com.mdm.agent

import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.os.Bundle
import android.os.PersistableBundle
import androidx.activity.ComponentActivity
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.mdm.core.admin.DevicePolicyController
import com.mdm.core.admin.ProvisioningStash
import com.mdm.enrollment.FirstBootEnroller
import timber.log.Timber

/**
 * Handles the Android 10+ fully-managed (Device Owner) provisioning hand-off.
 *
 * On targetSdk 31+, the Setup Wizard does NOT call
 * [com.mdm.core.admin.MDMDeviceAdminReceiver.onProfileProvisioningComplete] for
 * fully managed devices. Instead it launches the DPC's activity:
 *   1. ACTION_GET_PROVISIONING_MODE  — we answer "fully managed device".
 *   2. ACTION_ADMIN_POLICY_COMPLIANCE — carries the admin-extras bundle
 *      (server_url + enrollment_token + tenant_id) packed into the QR. We stash
 *      it and enqueue enrollment, then report RESULT_OK so setup can finish.
 *
 * Without this activity the bundle is silently dropped and the agent shows the
 * manual "enter server URL + token" screen — which is the bug this fixes. The
 * receiver callback is kept as a fallback for older platforms / managed profiles.
 */
class ProvisioningActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        when (intent?.action) {
            DevicePolicyManager.ACTION_GET_PROVISIONING_MODE -> {
                // The token's provisioning_mode (packed into the QR admin-extras)
                // decides whether the Setup Wizard creates a fully-managed device
                // or a managed (work) profile. Default: fully-managed.
                val mode = adminExtras()?.getString("provisioning_mode").orEmpty()
                val provisioningMode = if (mode == "work_profile")
                    DevicePolicyManager.PROVISIONING_MODE_MANAGED_PROFILE
                else
                    DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE
                Timber.i("GET_PROVISIONING_MODE: token mode='$mode' → $provisioningMode")
                setResult(
                    RESULT_OK,
                    Intent().putExtra(DevicePolicyManager.EXTRA_PROVISIONING_MODE, provisioningMode)
                )
            }
            DevicePolicyManager.ACTION_ADMIN_POLICY_COMPLIANCE -> {
                captureExtras()
                setResult(RESULT_OK)
            }
            else -> {
                Timber.w("ProvisioningActivity launched with unexpected action: ${intent?.action}")
                setResult(RESULT_CANCELED)
            }
        }
        finish()
    }

    private fun adminExtras(): PersistableBundle? =
        intent.getParcelableExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE)

    private fun captureExtras() {
        val extras = adminExtras()
        val server = extras?.getString("server_url").orEmpty()
        val token = extras?.getString("enrollment_token").orEmpty()
        val tenant = extras?.getString("tenant_id").orEmpty()
        val mode = extras?.getString("provisioning_mode").orEmpty()
        if (server.isBlank() || token.isBlank()) {
            Timber.w("ADMIN_POLICY_COMPLIANCE: admin extras missing (server/token blank) — manual enrollment will be required")
            return
        }
        val workProfile = mode == "work_profile"
        // Channel: this activity only fires from the Setup Wizard QR flow.
        ProvisioningStash(applicationContext).save(server, token, tenant, channel = "qr_setup")
        Timber.i("Provisioning extras stashed from ADMIN_POLICY_COMPLIANCE; server=$server tenant=$tenant workProfile=$workProfile")

        // Pre-grant the runtime permissions the agent will need, mirroring the
        // legacy receiver path (which doesn't fire on this platform). Use the
        // Profile-Owner-safe defaults inside a work profile (no DO-only force-on).
        runCatching {
            val ctrl = DevicePolicyController(applicationContext)
            if (workProfile) ctrl.applyProfileOwnerPermissionDefaults()
            else ctrl.applyDeviceOwnerPermissionDefaults()
        }.onFailure { Timber.w(it, "pre-grant permissions failed at provisioning") }

        // Enroll as soon as the network is up — independent of when the user
        // first opens the app. FirstBootEnroller is idempotent and clears the
        // stash on success.
        WorkManager.getInstance(applicationContext).enqueueUniqueWork(
            "first-boot-enroll",
            ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<FirstBootEnroller>()
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .build()
        )
    }
}

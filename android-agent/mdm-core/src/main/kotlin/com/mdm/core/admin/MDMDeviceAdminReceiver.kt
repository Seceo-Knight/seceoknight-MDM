package com.mdm.core.admin

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PersistableBundle
import timber.log.Timber

/**
 * Receives DPC lifecycle callbacks from the platform.
 *
 * Key responsibilities:
 *   - on ENABLED: nothing to do here; the agent's [MDMApplication] kicks off
 *     the foreground service if Device Owner is set.
 *   - on PROFILE_PROVISIONING_COMPLETE: this is invoked AFTER the Setup
 *     Wizard finishes the QR/afw# provisioning. We:
 *       1. Read the AdminExtras bundle (server URL + enrollment token);
 *       2. Persist them so [EnrollmentManager] picks them up on first launch;
 *       3. Activate sensible defaults (clear initial app-state lock).
 *   - on BOOT_COMPLETED: re-arm WorkManager / restart command service.
 */
class MDMDeviceAdminReceiver : DeviceAdminReceiver() {

    companion object {
        fun componentName(ctx: Context) = ComponentName(ctx, MDMDeviceAdminReceiver::class.java)

        // Decoupled service start: avoid a compile-time dep on :command-executor
        // (which itself depends on :mdm-core, which would create a cycle).
        private const val SERVICE_CLASS = "com.mdm.command.CommandService"

        private fun startCommandService(ctx: Context) {
            val intent = Intent().setComponent(ComponentName(ctx.packageName, SERVICE_CLASS))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent)
            else ctx.startService(intent)
        }

        private fun enqueueFirstBootEnroll(ctx: Context) = EnrollmentScheduler.enqueueFirstBootEnroll(ctx)
    }

    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
        Timber.i("DeviceAdmin enabled")
    }

    override fun onDisabled(context: Context, intent: Intent) {
        super.onDisabled(context, intent)
        // Anti-tamper black box: the agent's admin/owner role was just revoked.
        // Record it durably so it's exfiltrated on the next connection/boot even
        // if we lose privileges/network right now.
        Timber.w("DeviceAdmin DISABLED — recording tamper event")
        TamperStore(context).enqueue("admin_removed", "Device admin/owner role was revoked")
    }

    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        super.onProfileProvisioningComplete(context, intent)
        // This fires inside the freshly-created managed (work) profile after
        // ACTION_PROVISION_MANAGED_PROFILE (in-app) or legacy afw# provisioning.
        val extras: PersistableBundle? =
            intent.getParcelableExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE)
        if (extras != null) {
            val serverUrl = extras.getString("server_url").orEmpty()
            val token = extras.getString("enrollment_token").orEmpty()
            val tenant = extras.getString("tenant_id").orEmpty()
            // Channel: the in-app launcher packs how it was started; default to
            // qr_setup for legacy/QR-driven managed-profile provisioning.
            val channel = extras.getString("channel").takeUnless { it.isNullOrBlank() } ?: "qr_setup"
            Timber.i("Profile provisioning complete; server=$serverUrl tenant=$tenant channel=$channel")
            // Persist for first-boot pickup. Stored via EncryptedSharedPreferences
            // by ProvisioningStash so the EnrollmentManager can read it.
            ProvisioningStash(context).save(serverUrl, token, tenant, channel)
        }

        // Allow Settings + Play Store to operate; clear any default disabling.
        val dpm = context.getSystemService(DevicePolicyManager::class.java)
        val admin = componentName(context)
        // Mandatory: enable the app inside the profile so the user can continue
        // out of Setup.
        dpm.setProfileEnabled(admin)

        // Profile-Owner-safe permission pre-grant (no Device-Owner-only ops).
        runCatching { DevicePolicyController(context.applicationContext).applyProfileOwnerPermissionDefaults() }
            .onFailure { Timber.w(it, "pre-grant permissions failed at profile provisioning") }

        // Finish enrollment from the stash as soon as the network is up, then
        // bring up the command channel. Mirrors ProvisioningActivity's DO path.
        enqueueFirstBootEnroll(context)
        startCommandService(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        when (intent.action) {
            // Reboot: re-arm the worker chain + command service.
            Intent.ACTION_BOOT_COMPLETED,
            // App was just updated (adb install -r / OTA self-update). Android
            // leaves an updated app in the "stopped" state until something
            // launches it — which is exactly why the agent looked "off" after an
            // update until the user opened it by hand. The system delivers
            // MY_PACKAGE_REPLACED to us specifically (taking us out of the stopped
            // state to do so), so this is the canonical hook to relaunch the
            // service automatically post-update.
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                runCatching { startCommandService(context) }
                    .onFailure { Timber.w(it, "service restart after ${intent.action} failed") }
            }
        }
    }

    override fun onPasswordFailed(context: Context, intent: Intent) {
        // Could trigger PASSWORD_FAILED telemetry or attempt-based wipe here.
        Timber.w("Password failed; failed=${context.getSystemService(DevicePolicyManager::class.java).currentFailedPasswordAttempts}")
    }
}

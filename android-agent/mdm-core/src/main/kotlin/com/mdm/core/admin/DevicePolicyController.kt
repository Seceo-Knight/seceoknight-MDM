package com.mdm.core.admin

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.UserManager
import android.provider.Settings
import androidx.annotation.RequiresApi
import dagger.hilt.android.qualifiers.ApplicationContext
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Thin, testable wrapper over [DevicePolicyManager]. Every call is gated on
 * [isDeviceOwner] — non-DO devices silently no-op so a misconfigured build
 * never crashes the agent (but logs WARN so it's visible in telemetry).
 *
 * All restrictions go through [DevicePolicyManager.addUserRestriction] using
 * the [UserManager] constants. Adding new restrictions: extend [Restriction]
 * below; the [setRestriction] dispatcher does the rest.
 */
@Singleton
class DevicePolicyController @Inject constructor(
    @ApplicationContext private val context: Context
) {

    private val dpm: DevicePolicyManager =
        context.getSystemService(DevicePolicyManager::class.java)

    private val admin: ComponentName get() = MDMDeviceAdminReceiver.componentName(context)

    // -------------------- state queries --------------------

    fun isDeviceOwner(): Boolean = dpm.isDeviceOwnerApp(context.packageName)
    fun isAdminActive(): Boolean = dpm.isAdminActive(admin)

    /**
     * True when this app is the Profile Owner of a managed (work) profile —
     * the BYOD mode. Distinct from Device Owner: a Profile Owner only governs
     * the work profile, not the whole device. [guarded] still works for a PO
     * because the receiver is an active admin inside the profile.
     */
    fun isProfileOwner(): Boolean = dpm.isProfileOwnerApp(context.packageName)

    /** Coarse role string reported at enroll/heartbeat: device_owner | profile_owner | device_admin | none. */
    fun managementMode(): String = when {
        isDeviceOwner()  -> "device_owner"
        isProfileOwner() -> "profile_owner"
        isAdminActive()  -> "device_admin"
        else             -> "none"
    }

    // -------------------- destructive ops ------------------

    fun lockNow() = guarded("lockNow") { dpm.lockNow() }

    /**
     * Factory reset. Pass `WIPE_EXTERNAL_STORAGE` and `WIPE_RESET_PROTECTION_DATA`
     * for a true clean wipe; on Android 9+ also pass `WIPE_EUICC` if applicable.
     */
    fun wipeDevice(externalStorage: Boolean = true, resetProtection: Boolean = true) =
        guarded("wipeDevice") {
            var flags = 0
            if (externalStorage) flags = flags or DevicePolicyManager.WIPE_EXTERNAL_STORAGE
            if (resetProtection) flags = flags or DevicePolicyManager.WIPE_RESET_PROTECTION_DATA
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                flags = flags or DevicePolicyManager.WIPE_EUICC
            }
            dpm.wipeData(flags)
        }

    fun rebootDevice(reason: String? = null) = guarded("reboot") {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) dpm.reboot(admin)
    }

    // -------------------- self-removal ----------------------
    //
    // Used by the Dev Console "remove agent" action to make this package
    // uninstallable again. A Device Owner / active admin can NOT be uninstalled
    // while it holds those roles, so we voluntarily relinquish them first. The
    // APIs are deprecated but remain the only supported way for a managed app to
    // give up its own privileges (there is no newer replacement for self-removal).

    /** Relinquishes Device Owner so the package can be uninstalled. No-op if this
     *  app isn't the device owner. */
    @Suppress("DEPRECATION")
    fun clearDeviceOwner() {
        if (!isDeviceOwner()) return
        runCatching { dpm.clearDeviceOwnerApp(context.packageName) }
            .onFailure { Timber.w(it, "clearDeviceOwnerApp failed") }
    }

    /** Deactivates this app as a Device Admin so it can be uninstalled. No-op if
     *  the admin isn't currently active. */
    fun deactivateAdmin() {
        if (!isAdminActive()) return
        runCatching { dpm.removeActiveAdmin(admin) }
            .onFailure { Timber.w(it, "removeActiveAdmin failed") }
    }

    // -------------------- password policy ------------------

    fun setPasswordComplexity(complexity: Int) = guarded("setPasswordComplexity") {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            dpm.requiredPasswordComplexity = complexity
        }
    }

    fun setMinimumPasswordLength(min: Int) = guarded("setMinPasswordLength") {
        @Suppress("DEPRECATION")
        dpm.setPasswordMinimumLength(admin, min)
    }

    fun setMaxFailedPasswordsForWipe(max: Int) = guarded("setMaxFailedForWipe") {
        dpm.setMaximumFailedPasswordsForWipe(admin, max)
    }

    fun setPasswordExpirationTimeoutMs(ms: Long) = guarded("setPasswordExpiration") {
        dpm.setPasswordExpirationTimeout(admin, ms)
    }

    fun setInactivityLockSeconds(seconds: Int) = guarded("setInactivityLock") {
        dpm.setMaximumTimeToLock(admin, seconds * 1_000L)
    }

    /**
     * Sets a new lock-screen password. The platform method is deprecated as of
     * API 24 and silently no-ops for non-Device-Owner / non-Profile-Owner
     * callers in modern Android — [guarded] swallows the resulting
     * SecurityException so the agent stays alive; the caller ack-fails the
     * command with a clear message.
     */
    @Suppress("DEPRECATION")
    fun resetPassword(password: String): Boolean? = guarded("resetPassword") {
        dpm.resetPassword(password, 0)
    }

    // -------------------- reset-password token flow (DO, API 26+) ----------
    //
    // On Android O+ the only way for a Device Owner to change the lock-screen
    // password remotely is the token-based flow:
    //   1. setResetPasswordToken(admin, token) → caches the token.
    //   2. (one-time) user confirms current credentials on device, which
    //      activates the token.
    //   3. resetPasswordWithToken(admin, newPassword, token, flags) → works
    //      silently from then on.

    /**
     * Arms a reset-password token. Returns null on success, or a human-
     * readable diagnostic string describing why the platform refused.
     *
     * Common refusal causes (the admin needs the hint to fix it):
     *   - The device has no existing screen lock — the token API requires
     *     one to be active so it can be activated by the user.
     *   - File-Based Encryption is in direct-boot mode (rare).
     *   - The platform image strips reset-password-token support (very rare).
     */
    fun armResetPasswordToken(token: ByteArray): String? {
        return try {
            if (token.size < 32) return "token is ${token.size} bytes, minimum is 32"
            val ok = dpm.setResetPasswordToken(admin, token)
            if (ok) null
            else "setResetPasswordToken returned false. Most common cause: the device " +
                 "has no existing PIN/pattern/password lock yet — Android's token API " +
                 "requires an existing lock to activate the token. Set a lock on the " +
                 "device first, then retry."
        } catch (t: Throwable) {
            Timber.w(t, "setResetPasswordToken threw")
            "${t.javaClass.simpleName}: ${t.message ?: "no message"}"
        }
    }

    fun isResetPasswordTokenActive(): Boolean {
        return try { dpm.isResetPasswordTokenActive(admin) }
        catch (t: Throwable) { false }
    }

    /**
     * Clears any previously-set reset-password token. Safe to call even when
     * no token is set. Used to recover from a stuck-token state on devices
     * where setResetPasswordToken returns false when a stale token is present.
     */
    fun clearResetPasswordToken(): Boolean {
        return try { dpm.clearResetPasswordToken(admin) }
        catch (t: Throwable) { Timber.v(t, "clearResetPasswordToken no-op"); false }
    }

    fun resetPasswordWithToken(password: String, token: ByteArray): Boolean {
        return try {
            dpm.resetPasswordWithToken(admin, password, token,
                android.app.admin.DevicePolicyManager.RESET_PASSWORD_REQUIRE_ENTRY)
        } catch (t: Throwable) {
            Timber.w(t, "resetPasswordWithToken failed"); false
        }
    }

    // -------------------- location enforcement --------------

    /**
     * Reads whether device location services are currently on. Used by the
     * GET_LOCATION command to produce a precise failure reason.
     */
    fun isLocationEnabled(): Boolean {
        val lm = context.getSystemService(LocationManager::class.java) ?: return false
        return runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) lm.isLocationEnabled
            else @Suppress("DEPRECATION")
                lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
                lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
        }.getOrDefault(false)
    }

    /**
     * Enforces device location services ON and (when [lockOn]) prevents the
     * user from turning them back off. Device Owner only — [guarded] no-ops in
     * Device Admin / enrolled-only mode.
     *
     *  - setLocationEnabled (API 30+) flips the master location toggle on.
     *  - DISALLOW_CONFIG_LOCATION greys out the location setting so the user
     *    can't disable it again — "force on, can't be turned off".
     *
     * Idempotent; safe to re-call on every service start.
     */
    fun enforceLocationOn(lockOn: Boolean = true) = guarded("enforceLocationOn") {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            dpm.setLocationEnabled(admin, true)
        }
        if (lockOn) {
            dpm.addUserRestriction(admin, UserManager.DISALLOW_CONFIG_LOCATION)
        }
    }

    /** Lifts the location lock so the user can change location settings again. */
    fun releaseLocationLock() = guarded("releaseLocationLock") {
        dpm.clearUserRestriction(admin, UserManager.DISALLOW_CONFIG_LOCATION)
    }

    // -------------------- camera / capture ------------------

    fun setCameraDisabled(disabled: Boolean) = guarded("setCameraDisabled") {
        dpm.setCameraDisabled(admin, disabled)
    }

    /**
     * Reads the OS's current camera-disabled state. Used by capture paths
     * to detect a self-imposed disable and temporarily lift it for a
     * single shot, then restore.
     */
    fun isCameraDisabled(): Boolean = try {
        dpm.getCameraDisabled(admin)
    } catch (t: Throwable) { Timber.v(t, "getCameraDisabled failed"); false }

    fun setScreenCaptureDisabled(disabled: Boolean) = guarded("setScreenCaptureDisabled") {
        dpm.setScreenCaptureDisabled(admin, disabled)
    }

    /**
     * Allowlist the agent's OWN accessibility service (RemoteControlService) so it
     * can be enabled for screen-share consent auto-confirm + remote-control input.
     * `null` would permit all services; we permit only ourselves. NB: permitting is
     * NOT enabling — enabling on stock Android still needs a one-time user/adb action
     * (or Samsung Knox). Best-effort; no-op when we're not an owner.
     */
    fun permitOwnAccessibilityService() = guarded("permitAccessibilityServices") {
        dpm.setPermittedAccessibilityServices(admin, listOf(context.packageName))
    }

    // -------------------- generic user restrictions ---------

    /**
     * Mirrors PolicySpec.Restrictions field-by-field. The PolicyApplier uses
     * this as its dispatch table.
     */
    fun setRestriction(restriction: Restriction, enabled: Boolean) = guarded("restriction.${restriction.name}") {
        val key = restriction.userManagerKey
        if (enabled) dpm.addUserRestriction(admin, key) else dpm.clearUserRestriction(admin, key)
    }

    // -------------------- app management --------------------

    /**
     * Hide a package from the launcher (Device Owner-only). Use for blocklists
     * that should not be uninstalled but should be invisible.
     */
    fun setApplicationHidden(packageName: String, hidden: Boolean): Boolean = guarded("hide.$packageName") {
        dpm.setApplicationHidden(admin, packageName, hidden)
    } ?: false

    fun setUninstallBlocked(packageName: String, blocked: Boolean) = guarded("uninstallBlocked.$packageName") {
        dpm.setUninstallBlocked(admin, packageName, blocked)
    }

    fun isPackageInstalled(packageName: String): Boolean = try {
        context.packageManager.getPackageInfo(packageName, 0); true
    } catch (e: PackageManager.NameNotFoundException) { false }

    /**
     * Pushes a URL pattern blocklist into Chrome's Managed Configuration
     * bundle. Chrome (and Chromium-based browsers honoring the same schema:
     * Edge, Brave, etc.) blocks any in-app navigation matching one of the
     * patterns. Pattern syntax is the standard Chromium one — e.g.
     * `youtube.com`, `*.youtube.com`, or scheme-and-path wildcards.
     * Calling with an empty list clears the block by writing an empty array.
     *
     * Requires Device Owner / Profile Owner. Idempotent.
     */
    fun setChromeUrlBlocklist(patterns: List<String>) = guarded("setChromeUrlBlocklist") {
        val targets = listOf(
            "com.android.chrome",            // Chrome
            "com.chrome.beta", "com.chrome.dev", "com.chrome.canary",
            "com.microsoft.emmx",            // Edge (Chromium)
            "com.brave.browser",             // Brave
            "org.chromium.chrome"            // raw Chromium
        )
        // Expand each user-supplied pattern into the canonical Chrome
        // URLBlocklist forms so we maximize match coverage regardless of
        // how the user wrote it. "youtube.com" alone matches only the
        // bare host on some Chrome versions; the *://*.host/* form matches
        // subdomains across all schemes uniformly.
        val expanded = patterns.flatMap { p ->
            val raw = p.trim()
            if (raw.isEmpty()) emptyList()
            else if (raw.startsWith("http://") || raw.startsWith("https://") || raw.contains("://"))
                listOf(raw)
            else if (raw.startsWith("*.")) {
                val host = raw.removePrefix("*.")
                listOf(raw, "*://$raw/*", host, "*://$host/*")
            } else {
                listOf(raw, "*.$raw", "*://$raw/*", "*://*.$raw/*")
            }
        }.distinct()
        val arr = expanded.toTypedArray()
        val bundle = android.os.Bundle().apply {
            // URLBlocklist is the current key (Chrome ≥86); URLBlacklist is
            // the legacy name. Setting both makes the policy work across the
            // historical range with one push.
            putStringArray("URLBlocklist", arr)
            putStringArray("URLBlacklist", arr)
        }
        for (pkg in targets) {
            if (!isPackageInstalled(pkg)) continue
            try {
                dpm.setApplicationRestrictions(admin, pkg, bundle)
                // setApplicationRestrictions normally fires
                // ACTION_APPLICATION_RESTRICTIONS_CHANGED automatically, but
                // some Chrome builds only pick up changes on next launch.
                // Send the broadcast explicitly so already-running Chrome
                // re-reads the bundle immediately.
                try {
                    val intent = android.content.Intent(
                        android.content.Intent.ACTION_APPLICATION_RESTRICTIONS_CHANGED
                    ).apply {
                        setPackage(pkg)
                        addFlags(android.content.Intent.FLAG_INCLUDE_STOPPED_PACKAGES)
                    }
                    context.sendBroadcast(intent)
                } catch (bt: Throwable) {
                    Timber.w(bt, "broadcast restrictions-changed failed for $pkg")
                }
                Timber.i("Pushed URLBlocklist (${expanded.size} expanded patterns from ${patterns.size}) to $pkg")
            } catch (t: Throwable) {
                Timber.w(t, "setApplicationRestrictions failed for $pkg")
            }
        }
    }

    /**
     * Clears app data (cache + sharedPrefs + databases). Fires-and-forgets;
     * the system callback fires once the wipe completes but we don't surface
     * it here — the command result is "issued" rather than "completed".
     */
    fun clearApplicationUserData(packageName: String) = guarded("clearApplicationUserData") {
        dpm.clearApplicationUserData(
            admin, packageName,
            java.util.concurrent.Executors.newSingleThreadExecutor()
        ) { _, _ -> /* fire-and-forget */ }
    }

    /**
     * Grants a runtime permission to a package without prompting the user.
     * Only effective in Device Owner / Profile Owner mode on API 23+.
     * No-op (returns false) in Device Admin mode.
     */
    fun grantRuntimePermission(packageName: String, permission: String): Boolean {
        return try {
            dpm.setPermissionGrantState(
                admin, packageName, permission,
                android.app.admin.DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED
            )
        } catch (t: Throwable) {
            Timber.w(t, "grantRuntimePermission $permission denied (DO required)")
            false
        }
    }

    /**
     * Idempotent: switches the platform-wide permission policy to
     * AUTO_GRANT for our own package and pre-grants the runtime
     * permissions the agent ever asks for. Must be called once after
     * Device Owner is established (and is safe to re-call on every
     * service start — DPM is happy with redundant calls).
     *
     * On non-DO devices [guarded] short-circuits and we silently
     * downgrade to per-command lazy grants in the executor.
     */
    fun applyDeviceOwnerPermissionDefaults() {
        if (!isAdminActive()) {
            Timber.w("permission defaults skipped: admin not active")
            return
        }
        runCatching {
            // PERMISSION_POLICY_AUTO_GRANT: every future runtime permission
            // request by *this* package is auto-granted without a dialog.
            dpm.setPermissionPolicy(admin, DevicePolicyManager.PERMISSION_POLICY_AUTO_GRANT)
        }.onFailure { Timber.w(it, "setPermissionPolicy AUTO_GRANT failed (DO required?)") }

        // Belt-and-suspenders: also explicitly mark each known runtime
        // permission as GRANTED. The AUTO_GRANT policy only fires on a
        // requestPermissions() call; older Android versions don't always
        // honor it for permissions never explicitly requested.
        val pkg = context.packageName
        // FINE/COARSE must precede BACKGROUND — Android only lets you grant
        // background location once foreground location is already granted.
        val perms = listOf(
            android.Manifest.permission.CAMERA,
            android.Manifest.permission.RECORD_AUDIO,
            android.Manifest.permission.ACCESS_FINE_LOCATION,
            android.Manifest.permission.ACCESS_COARSE_LOCATION,
            android.Manifest.permission.ACCESS_BACKGROUND_LOCATION,
            android.Manifest.permission.POST_NOTIFICATIONS,
            android.Manifest.permission.READ_PHONE_STATE
        )
        var granted = 0
        for (p in perms) {
            if (grantRuntimePermission(pkg, p)) granted++
        }
        Timber.i("Pre-granted $granted/${perms.size} runtime permissions to $pkg")

        // Force device location services on and lock them so a managed device
        // is always locatable — the user can't disable location to hide. No-op
        // outside Device Owner mode.
        enforceLocationOn(lockOn = true)
    }

    // -------------------- certs -----------------------------

    fun installCaCert(certPem: ByteArray): Boolean = guarded("installCaCert") {
        dpm.installCaCert(admin, certPem)
    } ?: false

    fun removeCaCert(certPem: ByteArray) = guarded("removeCaCert") {
        dpm.uninstallCaCert(admin, certPem)
    }

    // -------------------- wifi / proxy ----------------------

    @RequiresApi(Build.VERSION_CODES.N)
    fun setAlwaysOnVpn(packageName: String?, lockdown: Boolean) = guarded("alwaysOnVpn") {
        // packageName == null clears any always-on VPN binding.
        dpm.setAlwaysOnVpnPackage(admin, packageName, lockdown)
    }

    fun setGlobalProxy(host: String?, port: Int, exclusionList: List<String>) = guarded("globalProxy") {
        // setRecommendedGlobalProxy is the modern replacement for the
        // deprecated setGlobalProxy(admin, java.net.Proxy, exclusions)
        // overload and is the only one that accepts a [ProxyInfo].
        // host == null clears the global proxy.
        if (host.isNullOrBlank()) {
            dpm.setRecommendedGlobalProxy(admin, null)
            Timber.i("Cleared global proxy")
        } else {
            val proxy = android.net.ProxyInfo.buildDirectProxy(host, port, exclusionList)
            dpm.setRecommendedGlobalProxy(admin, proxy)
            Timber.i("Set global proxy $host:$port (excl=${exclusionList.joinToString(",")})")
        }
    }

    // -------------------- system update ---------------------

    fun setSystemUpdatePolicy(mode: Int, windowStartMin: Int, windowEndMin: Int) = guarded("systemUpdate") {
        val policy = when (mode) {
            android.app.admin.SystemUpdatePolicy.TYPE_INSTALL_AUTOMATIC ->
                android.app.admin.SystemUpdatePolicy.createAutomaticInstallPolicy()
            android.app.admin.SystemUpdatePolicy.TYPE_INSTALL_WINDOWED ->
                android.app.admin.SystemUpdatePolicy.createWindowedInstallPolicy(windowStartMin, windowEndMin)
            android.app.admin.SystemUpdatePolicy.TYPE_POSTPONE ->
                android.app.admin.SystemUpdatePolicy.createPostponeInstallPolicy()
            else -> null
        }
        dpm.setSystemUpdatePolicy(admin, policy)
    }

    // -------------------- work profile (Profile Owner) ------
    //
    // These are scoped to the managed (work) profile. They no-op on a
    // non-admin device via [guarded]; on a Device Owner most also work but
    // semantically belong to the BYOD profile flow.

    /**
     * Removes ONLY the work profile and all its apps/data — no factory reset.
     * The Profile Owner self-wipe is `wipeData(0)` (no WIPE_* flags). After
     * this the agent inside the profile is gone; the personal side is
     * untouched. Used by the REMOVE_WORK_PROFILE command.
     */
    fun wipeProfile() = guarded("wipeProfile") { dpm.wipeData(0) }

    /** Block the user from deleting the work profile themselves (true) or allow it. */
    fun setProfileRemovalBlocked(blocked: Boolean) =
        setRestriction(Restriction.BlockProfileRemoval, blocked)

    /** Hide work contacts from personal dialer/contacts search when disabled. */
    fun setCrossProfileContactsSearchDisabled(disabled: Boolean) =
        guarded("crossProfileContacts") { dpm.setCrossProfileContactsSearchDisabled(admin, disabled) }

    /** Hide work caller-ID in the personal phone app when disabled. */
    fun setCrossProfileCallerIdDisabled(disabled: Boolean) =
        guarded("crossProfileCallerId") { dpm.setCrossProfileCallerIdDisabled(admin, disabled) }

    /**
     * Disable cross-profile calendar sharing (work events invisible to the
     * personal calendar) by allowing zero packages; `disabled=false` clears
     * the restriction (null = all packages allowed). API 30+.
     */
    fun setCrossProfileCalendarDisabled(disabled: Boolean) = guarded("crossProfileCalendar") {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            dpm.setCrossProfileCalendarPackages(admin, if (disabled) emptySet() else null)
        }
    }

    /**
     * Require a SEPARATE work-profile challenge (distinct from the device
     * lock). Setting a non-NONE required complexity on a Profile Owner forces
     * the platform to prompt the user to set a dedicated work lock; `false`
     * lifts the requirement. API 29+.
     */
    fun setSeparateWorkChallenge(required: Boolean) = guarded("separateWorkChallenge") {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            dpm.requiredPasswordComplexity =
                if (required) DevicePolicyManager.PASSWORD_COMPLEXITY_MEDIUM
                else DevicePolicyManager.PASSWORD_COMPLEXITY_NONE
        }
    }

    /**
     * Suspend (freeze) or un-suspend packages without uninstalling. Suspended
     * apps can't be launched and show a dialog. Returns the packages that
     * could NOT be suspended (system/unsuspendable), or empty. API 24+.
     */
    fun setPackagesSuspended(packages: List<String>, suspended: Boolean): List<String> {
        if (packages.isEmpty()) return emptyList()
        return guarded("setPackagesSuspended") {
            dpm.setPackagesSuspended(admin, packages.toTypedArray(), suspended)?.toList() ?: emptyList()
        } ?: packages  // guarded no-op → treat all as "not applied"
    }

    /**
     * Auto-pause the managed profile after it's been turned off for [minutes]
     * (0 disables the limit). API 31+; no-op below S.
     */
    fun setManagedProfileMaximumTimeOff(minutes: Int) = guarded("maxTimeOff") {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            dpm.setManagedProfileMaximumTimeOff(admin, minutes.coerceAtLeast(0) * 60_000L)
        }
    }

    /**
     * Pushes a managed-configuration bundle to a package
     * (setApplicationRestrictions). Generic version of [setChromeUrlBlocklist]
     * for any app that reads RestrictionsManager app restrictions.
     */
    fun setApplicationRestrictions(packageName: String, config: Map<String, String>) = guarded("appRestrictions.$packageName") {
        val bundle = android.os.Bundle().apply { config.forEach { (k, v) -> putString(k, v) } }
        dpm.setApplicationRestrictions(admin, packageName, bundle)
    }

    /**
     * Profile-Owner analogue of [applyDeviceOwnerPermissionDefaults]: switch
     * the in-profile permission policy to AUTO_GRANT and pre-grant the runtime
     * permissions the agent uses, so headless commands inside the profile
     * don't hit a dialog. Skips the Device-Owner-only location force-on.
     */
    fun applyProfileOwnerPermissionDefaults() {
        if (!isAdminActive()) {
            Timber.w("PO permission defaults skipped: admin not active"); return
        }
        runCatching {
            dpm.setPermissionPolicy(admin, DevicePolicyManager.PERMISSION_POLICY_AUTO_GRANT)
        }.onFailure { Timber.w(it, "setPermissionPolicy AUTO_GRANT failed (PO required?)") }
        val pkg = context.packageName
        val perms = listOf(
            android.Manifest.permission.CAMERA,
            android.Manifest.permission.RECORD_AUDIO,
            android.Manifest.permission.ACCESS_FINE_LOCATION,
            android.Manifest.permission.ACCESS_COARSE_LOCATION,
            android.Manifest.permission.POST_NOTIFICATIONS,
            android.Manifest.permission.READ_PHONE_STATE
        )
        var granted = 0
        for (p in perms) if (grantRuntimePermission(pkg, p)) granted++
        Timber.i("PO pre-granted $granted/${perms.size} runtime permissions to $pkg")

        // App delivery into a BYOD work profile goes through the user-consented
        // PackageInstaller path (a Profile Owner can't install silently). Make
        // sure a stale DISALLOW_INSTALL_UNKNOWN_SOURCES — e.g. left over from a
        // previously-applied policy — can't HARD-block that with the system's
        // "action not allowed, contact your IT administrator" error. We only
        // clear the install BLOCK here; the per-install user consent (the
        // "install unknown apps" app-op) is still the user's to grant, surfaced
        // by the permissions panel. A policy can re-assert this restriction.
        runCatching { dpm.clearUserRestriction(admin, UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES) }
            .onFailure { Timber.w(it, "clear DISALLOW_INSTALL_UNKNOWN_SOURCES failed") }
    }

    // -------------------- safe net helper -------------------

    private inline fun <T> guarded(op: String, block: () -> T): T? {
        // We gate on isAdminActive() rather than isDeviceOwner() so this same
        // build works in two modes:
        //   - Production: provisioned as Device Owner; all ops succeed.
        //   - Dev/test:   activated via `adb shell dpm set-active-admin …`;
        //                 lock + basic password ops work, the DO-only ops
        //                 (silent install, restrictions, proxy, …) throw
        //                 SecurityException and we catch + log them below
        //                 so the agent keeps running instead of crashing.
        return if (!isAdminActive()) {
            Timber.w("DPM op $op skipped: admin not active")
            null
        } else try {
            block()
        } catch (t: SecurityException) {
            Timber.w(t, "DPM op $op denied — requires Device Owner (running as DA?)")
            null
        } catch (t: Throwable) {
            Timber.e(t, "DPM op $op failed")
            null
        }
    }
}

/**
 * Maps PolicySpec.Restrictions keys to platform UserManager constants. New
 * restrictions: add an entry, no other code changes needed.
 */
enum class Restriction(val userManagerKey: String) {
    DisableCamera           (UserManager.DISALLOW_CAMERA_TOGGLE.run { "no_camera" }), // legacy key for compat
    DisableScreenCapture    ("no_screen_capture"),
    DisableUSBFileTransfer  (UserManager.DISALLOW_USB_FILE_TRANSFER),
    DisableBluetooth        (UserManager.DISALLOW_BLUETOOTH),
    DisableNFC              (UserManager.DISALLOW_OUTGOING_BEAM),
    DisableHotspot          (UserManager.DISALLOW_CONFIG_TETHERING),
    DisableLocation         (UserManager.DISALLOW_SHARE_LOCATION),
    DisableUnknownSources   (UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES),
    DisableAccessibility    (UserManager.DISALLOW_CONFIG_LOCATION),  // closest analogue
    DisableFactoryReset     (UserManager.DISALLOW_FACTORY_RESET),
    DisableSafeBoot         (UserManager.DISALLOW_SAFE_BOOT),
    DisableAddUser          (UserManager.DISALLOW_ADD_USER),

    // Work-profile (Profile Owner) restrictions.
    ClipboardIsolation      (UserManager.DISALLOW_CROSS_PROFILE_COPY_PASTE),
    BlockExternalSharing    (UserManager.DISALLOW_SHARE_INTO_MANAGED_PROFILE),
    BlockAppInstall         (UserManager.DISALLOW_INSTALL_APPS),
    BlockUninstall          (UserManager.DISALLOW_UNINSTALL_APPS),
    BlockProfileRemoval     (UserManager.DISALLOW_REMOVE_MANAGED_PROFILE);
}

package com.mdm.command

import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import com.mdm.camera.Buzzer
import com.mdm.camera.CameraCapture
import com.mdm.camera.LocationFix
import com.mdm.core.admin.DevicePolicyController
import com.mdm.core.admin.ResetPasswordTokenStore
import com.mdm.core.admin.Restriction
import com.mdm.networking.api.CommandDto
import com.mdm.networking.api.CommandResultDto
import com.mdm.networking.api.MdmApi
import com.mdm.networking.auth.AuthRepository
import com.mdm.networking.auth.TokenStore
import com.mdm.core.admin.Restriction as RestrictionType
import com.mdm.policy.PolicyEngine
import com.mdm.security.IntegrityChecker
import com.mdm.telemetry.TelemetryCollector
import dagger.hilt.android.qualifiers.ApplicationContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Dispatches one [CommandDto] to the right side-effect and reports the
 * outcome back to the server via `POST /api/v1/commands/{id}/result`.
 *
 * Idempotency: each branch is responsible for its own. MQTT delivery is
 * QoS 1 (at-least-once); duplicate INSTALL_APP / SET_RESTRICTION calls must
 * yield the same end state.
 *
 * Exhaustive `when` is intentional — any new [CommandKind] is a compile
 * error here, which is exactly what we want.
 */
@Singleton
class CommandExecutor @Inject constructor(
    @ApplicationContext private val context: Context,
    private val dpm: DevicePolicyController,
    private val installer: AppInstaller,
    private val policyEngine: PolicyEngine,
    private val collector: TelemetryCollector,
    private val integrity: IntegrityChecker,
    private val camera: CameraCapture,
    private val audioStream: AudioStreamManager,
    private val locator: LocationFix,
    private val buzzer: Buzzer,
    private val resetTokens: ResetPasswordTokenStore,
    private val api: MdmApi,
    private val auth: AuthRepository,
    private val tokens: TokenStore,
    private val screenShare: WebRtcScreenShareManager
) {

    suspend fun execute(cmd: CommandDto) {
        val kind = CommandKind.fromWire(cmd.kind)
        if (kind == null) {
            complete(cmd, success = false, result = null, error = "unknown kind: ${cmd.kind}")
            return
        }
        Timber.i("Executing ${kind.name} id=${cmd.id}")
        // Self-update is special: committing our OWN apk kills this process
        // mid-install, so a normal post-result after the commit never runs.
        // Instead of pre-acking success (which masked failed downloads as a false
        // "succeeded"), we drive the install directly and ack at the last SAFE
        // moment — once the APK is fully downloaded+staged, just before the
        // process-killing commit. So a bad download/URL/network now reports a real
        // FAILURE, while a genuine update still shows "succeeded" (then the new
        // version confirms by reconnecting with a bumped agent_version_code).
        val selfUpdate = kind == CommandKind.INSTALL_APP &&
            (cmd.payload?.get("package_name") as? String) == context.packageName
        if (selfUpdate) {
            val p = cmd.payload.orEmpty()
            var staged = false
            try {
                installer.install(
                    packageName = context.packageName,
                    downloadObjectId = p["download_object_id"] as? String,
                    directUrl = p["download_url"] as? String,
                    onStaged = {
                        staged = true
                        complete(cmd, success = true, error = null, result = mapOf(
                            "self_update"  to true,
                            "from_version" to "${agentVersionName()} (${agentVersionCode()})",
                            "note"         to "Update staged — committing; device will reconnect on the new version.",
                            "at"           to nowIso()
                        ))
                    }
                )
            } catch (t: Throwable) {
                Timber.e(t, "self-update failed (staged=$staged)")
                // Only report failure if we never got to the ack — past staging a
                // throw is the (rare) commit step, by which point we may already
                // be on our way down; don't overwrite the success we just posted.
                if (!staged) complete(cmd, success = false, result = null,
                    error = "update failed: ${t.message ?: t::class.java.simpleName}")
            }
            return
        }
        // REBOOT must ack BEFORE it runs. The reboot kills this process before a
        // post-execute complete() could fire, so the command stays 'dispatched' —
        // and the server re-delivers dispatched-but-unacked commands on every poll
        // (until timeout_at, without bumping attempts), so the device reboots again
        // on each boot: a reboot LOOP. Posting the result first (awaited) makes the
        // command terminal ('succeeded') before we go down, breaking the loop.
        if (kind == CommandKind.REBOOT) {
            complete(cmd, success = true, error = null, result = mapOf("rebooting" to true, "at" to nowIso()))
            runCatching { dpm.rebootDevice(cmd.payload?.get("reason") as? String) }
                .onFailure { Timber.e(it, "reboot failed") }
            return
        }
        try {
            val result = handle(kind, cmd.payload.orEmpty())
            complete(cmd, success = true, result = result, error = null)
        } catch (t: Throwable) {
            Timber.e(t, "Command ${cmd.id} failed")
            complete(cmd, success = false, result = null, error = t.message ?: t::class.java.simpleName)
        }
    }

    private fun agentVersionName(): String = runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: AGENT_VERSION
    }.getOrDefault(AGENT_VERSION)

    private fun agentVersionCode(): Long = runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).versionCodeCompat()
    }.getOrDefault(0L)

    /**
     * Returns a result map for commands that produce data (FETCH_*); null
     * for fire-and-forget operations (LOCK, WIPE, etc.).
     */
    private suspend fun handle(kind: CommandKind, p: Map<String, Any?>): Map<String, Any?>? = when (kind) {
        CommandKind.LOCK   -> { dpm.lockNow(); null }
        CommandKind.WIPE   -> {
            dpm.wipeDevice(
                externalStorage = p.bool("external_storage", true),
                resetProtection = p.bool("reset_protection", true)
            ); null
        }
        CommandKind.REBOOT -> { dpm.rebootDevice(p["reason"] as? String); null }

        CommandKind.REMOVE_WORK_PROFILE -> {
            if (!dpm.isProfileOwner())
                error("not a work profile (Profile Owner) — nothing to remove")
            // wipeData(0) tears down only this profile; the process dies as the
            // profile is removed, so the result may never reach the server.
            dpm.wipeProfile()
            mapOf("profile_removed" to true, "at" to nowIso())
        }

        CommandKind.SYNC_POLICY, CommandKind.APPLY_POLICY -> {
            val v = policyEngine.sync()
            mapOf("applied_version" to v)
        }

        CommandKind.START_SCREEN_SHARE -> {
            // Live screen mirror over WebRTC. Device Owner only (the device is
            // company-owned). The actual stream starts asynchronously after the
            // MediaProjection consent — which the agent's accessibility service
            // auto-confirms — so this just kicks it off.
            if (!dpm.isDeviceOwner()) error("screen share requires Device Owner")
            val sessionId = (p["session_id"] as? String) ?: "screen_${System.currentTimeMillis()}"
            val record = p.bool("record", true)
            // ICE servers (STUN/TURN) are minted server-side and passed in the
            // payload so this headless device needn't call the admin-only endpoint.
            val iceJson = runCatching {
                org.json.JSONArray((p["ice_servers"] as? Collection<*>) ?: emptyList<Any>()).toString()
            }.getOrDefault("[]")
            // Assert the mediaProjection FGS type (Android 14) BEFORE capturing.
            CommandService.screenSharing = true
            CommandService.start(context, tickNow = true)
            // Launch the transparent consent activity (in :app) by name — no module
            // dependency. It obtains the projection token and hands it to the
            // shared WebRtcScreenShareManager singleton.
            runCatching {
                val intent = android.content.Intent().apply {
                    setClassName(context.packageName, "com.mdm.agent.ProjectionRequestActivity")
                    addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    putExtra("session_id", sessionId)
                    putExtra("ice_servers", iceJson)
                    putExtra("record", record)
                }
                context.startActivity(intent)
            }.onFailure { Timber.e(it, "screen: failed to launch projection activity") }
            mapOf("session" to sessionId, "started" to true, "at" to nowIso())
        }

        CommandKind.STOP_SCREEN_SHARE -> {
            val sessionId = p["session_id"] as? String
            screenShare.stop(sessionId)
            CommandService.screenSharing = false
            CommandService.start(context, tickNow = true)
            mapOf("stopped" to true, "at" to nowIso())
        }

        CommandKind.WAKE_DEVICE -> {
            // Remote power-button: turn the screen on. The live mirror captures
            // only a *rendering* display, so when the screen sleeps the capture
            // goes black and the WebRTC session dies — an admin uses this to wake
            // the device and bring the mirror back. Device Owner only (matches
            // screen share). The actual wake happens in WakeActivity via
            // setTurnScreenOn(): reliable from a fully-off/locked state, unlike a
            // bare FULL_WAKE_LOCK which no longer lights the screen on modern
            // Android. Launched by class name (no :app module dependency), same
            // as START_SCREEN_SHARE launches ProjectionRequestActivity.
            if (!dpm.isDeviceOwner()) error("wake device requires Device Owner")
            val wasInteractive = runCatching {
                context.getSystemService(android.os.PowerManager::class.java)?.isInteractive == true
            }.getOrDefault(false)
            runCatching {
                val intent = android.content.Intent().apply {
                    setClassName(context.packageName, "com.mdm.agent.WakeActivity")
                    addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
            }.onFailure { Timber.e(it, "wake: failed to launch wake activity") }
            mapOf("woke" to true, "was_interactive" to wasInteractive, "at" to nowIso())
        }

        CommandKind.CLEAR_POLICY -> {
            // Roll back everything the PolicyApplier may have set. Each
            // step is independent + idempotent — a partial failure (e.g.
            // setCameraDisabled returns null because we're not actually DO)
            // doesn't abort the others.
            var cleared = 0
            // Camera + screen capture
            dpm.setCameraDisabled(false); cleared++
            dpm.setScreenCaptureDisabled(false); cleared++
            // All user restrictions
            RestrictionType.values().forEach {
                dpm.setRestriction(it, false); cleared++
            }
            // Chrome URL blocklist
            dpm.setChromeUrlBlocklist(emptyList()); cleared++
            tokens.setUrlBlocklist(emptyList())
            // App blocklist: re-show every package we previously hid.
            val prevBlock = tokens.appBlocklist()
            for (pkg in prevBlock) {
                dpm.setApplicationHidden(pkg, false)
                dpm.setUninstallBlocked(pkg, false)
                cleared++
            }
            tokens.setAppBlocklist(emptyList())
            // Surveillance toggles
            tokens.setCaptureOnUnlock(false); cleared++
            // Network: best-effort clear (no-ops if never set).
            runCatching { dpm.setAlwaysOnVpn(null, false) }
            runCatching { dpm.setGlobalProxy(null, 0, emptyList()) }
            // Forget the last-applied spec so the next APPLY_POLICY doesn't
            // try to diff against stale state.
            tokens.setLastAppliedSpecJson(null)
            // Local policy version so the next APPLY_POLICY isn't short-
            // circuited as "unchanged" against the now-stale lastVersion.
            policyEngine.resetLocalVersion()
            mapOf(
                "cleared_actions" to cleared,
                "previous_blocklist" to prevBlock,
                "at" to nowIso()
            )
        }

        CommandKind.INSTALL_APP -> {
            // package_name is optional now — empty means "let the installer
            // resolve from the APK manifest at commit time".
            val pkg = p["package_name"] as? String
            installer.install(
                packageName = pkg,
                downloadObjectId = p["download_object_id"] as? String,
                directUrl = p["download_url"] as? String
            )
            mapOf(
                "package_name" to (pkg ?: "(auto)"),
                "silent"       to dpm.isDeviceOwner(),
                "note"         to (if (dpm.isDeviceOwner())
                    "silent install committed"
                else
                    "install dialog presented on device — user must tap Install"),
                "at" to nowIso()
            )
        }
        CommandKind.UNINSTALL_APP    -> { installer.uninstall(p.str("package_name")); null }
        CommandKind.HIDE_APP         -> { dpm.setApplicationHidden(p.str("package_name"), true); null }
        CommandKind.SHOW_APP         -> { dpm.setApplicationHidden(p.str("package_name"), false); null }
        CommandKind.BLOCK_UNINSTALL  -> { dpm.setUninstallBlocked(p.str("package_name"), true); null }
        CommandKind.ALLOW_UNINSTALL  -> { dpm.setUninstallBlocked(p.str("package_name"), false); null }

        CommandKind.INSTALL_CERT -> {
            val pem = android.util.Base64.decode(p.str("pem_base64"), android.util.Base64.DEFAULT)
            dpm.installCaCert(pem); null
        }
        CommandKind.REMOVE_CERT -> {
            val pem = android.util.Base64.decode(p.str("pem_base64"), android.util.Base64.DEFAULT)
            dpm.removeCaCert(pem); null
        }

        CommandKind.SET_VPN   -> { dpm.setAlwaysOnVpn(p.str("package_name"), p.bool("lockdown", false)); null }
        CommandKind.SET_PROXY -> {
            @Suppress("UNCHECKED_CAST")
            val excl = (p["exclusions"] as? List<String>) ?: emptyList()
            dpm.setGlobalProxy(p.str("host"), p.int("port"), excl); null
        }
        CommandKind.SET_RESTRICTION -> {
            val name = p.str("key")
            val enabled = p.bool("enabled", true)
            val r = runCatching { Restriction.valueOf(name) }.getOrNull()
                ?: error("unknown restriction: $name")
            dpm.setRestriction(r, enabled); null
        }
        CommandKind.SET_PASSWORD_POLICY -> {
            (p["complexity"] as? Number)?.toInt()?.let { dpm.setPasswordComplexity(it) }
            (p["minimum_length"] as? Number)?.toInt()?.let { dpm.setMinimumPasswordLength(it) }
            (p["max_failed_for_wipe"] as? Number)?.toInt()?.let { dpm.setMaxFailedPasswordsForWipe(it) }
            (p["expiration_ms"] as? Number)?.toLong()?.let { dpm.setPasswordExpirationTimeoutMs(it) }
            (p["inactivity_lock_seconds"] as? Number)?.toInt()?.let { dpm.setInactivityLockSeconds(it) }
            null
        }
        CommandKind.SET_SYSTEM_UPDATE -> {
            dpm.setSystemUpdatePolicy(
                mode = p.int("mode"),
                windowStartMin = p["window_start_min"]?.let { (it as Number).toInt() } ?: 0,
                windowEndMin   = p["window_end_min"]?.let   { (it as Number).toInt() } ?: 0
            ); null
        }

        CommandKind.PUSH_TELEMETRY -> null   // periodic worker handles bulk push
        CommandKind.PING           -> mapOf("pong" to true, "at" to nowIso())

        CommandKind.CLEAR_PASSWORD -> {
            // No safe way to clear the lock password without DPM token machinery.
            error("CLEAR_PASSWORD requires Device Owner with a pre-set reset token")
        }
        CommandKind.RESET_PASSWORD -> {
            val newPassword = p["password"] as? String
                ?: error("missing 'password'")
            // The token path works for BOTH a Device Owner (resets the device
            // lock) AND a Profile Owner (resets the work-profile challenge) —
            // resetPasswordWithToken is the only API Android 8+ allows to change
            // an ALREADY-SET password, and it's exactly how a forgotten work
            // password gets reset from the console. Only a bare Device Admin has
            // to fall back to the legacy resetPassword.
            if (!dpm.isDeviceOwner() && !dpm.isProfileOwner()) {
                val ok = dpm.resetPassword(newPassword)
                if (ok != true) {
                    error("Direct resetPassword is gated to Device Owner / Profile Owner on Android 8+. " +
                          "Promote the agent to Device Owner or work-profile (Profile Owner) mode and retry.")
                }
                mapOf("method" to "legacy", "at" to nowIso())
            } else {
                val token = resetTokens.getOrCreate()
                val active = dpm.isResetPasswordTokenActive()
                if (!active) {
                    // First arm attempt with the existing stored token.
                    var armErr = dpm.armResetPasswordToken(token)
                    if (armErr != null) {
                        // Some platforms reject a fresh setResetPasswordToken when
                        // a stale (but inactive) token is still parked. Clear and
                        // retry once before bailing out.
                        Timber.w("first arm attempt failed: $armErr — clearing token and retrying")
                        dpm.clearResetPasswordToken()
                        armErr = dpm.armResetPasswordToken(token)
                    }
                    if (armErr != null) error("setResetPasswordToken failed: $armErr")
                    error("Reset-password token armed but not yet active. " +
                          "On the device: open Settings → Security → unlock with the CURRENT PIN/pattern/password " +
                          "to activate the token, then retry RESET_PASSWORD from the admin console.")
                }
                val ok = dpm.resetPasswordWithToken(newPassword, token)
                if (!ok) error("resetPasswordWithToken returned false (token may have been invalidated — " +
                               "either the lock screen credentials changed on-device since the token was armed, " +
                               "or the password doesn't meet the device's complexity policy).")
                mapOf("method" to "token", "mode" to dpm.managementMode(), "at" to nowIso())
            }
        }
        CommandKind.LOG_OFF_USER -> error("LOG_OFF_USER not supported on single-user DO")

        CommandKind.FETCH_DEVICE_INFO -> {
            val s = collector.snapshot()
            val ig = integrity.snapshot()
            mapOf(
                "manufacturer"        to s.manufacturer,
                "model"               to s.model,
                "android_version"     to s.androidVersion,
                "sdk"                 to s.sdk,
                "patch_level"         to s.patchLevel,
                "battery_pct"         to s.batteryPct,
                "charging"            to s.charging,
                "screen_on"           to s.screenOn,
                "network"             to s.network,
                "ip_address"          to s.ipAddress,
                "mac_address"         to s.macAddress,
                "wifi_ssid"           to s.ssid,
                "storage_free_bytes"  to s.storageFreeBytes,
                "storage_total_bytes" to s.storageTotalBytes,
                "rooted"              to ig.rooted,
                "debuggable"          to ig.debuggable,
                "emulator"            to ig.emulator,
                "adb_enabled"         to ig.adbEnabled,
                "signature_sha256"    to ig.selfSignatureSha256,
                "device_owner"        to dpm.isDeviceOwner(),
                "admin_active"        to dpm.isAdminActive(),
                "agent_version"       to agentVersionName(),
                "agent_version_code"  to agentVersionCode(),
                // What the MDM agent ITSELF has been granted on this device —
                // runtime permissions, special-access toggles and admin role.
                // Surfaced for every device regardless of management mode.
                "mdm_permissions"     to mdmPermissions(),
                "fetched_at"          to nowIso()
            )
        }

        CommandKind.FETCH_APP_INVENTORY -> {
            // Always return every installed app, including system apps —
            // the admin UI filters client-side. The historical
            // `include_system` payload is now ignored; keeping the field
            // accepted for back-compat with older command callers.
            //
            // `system` here is NOT just FLAG_SYSTEM. Android's FLAG_SYSTEM is
            // set on every app shipped in /system, /vendor or /product —
            // which on a stock OEM phone means Chrome, Gmail, YouTube, Maps,
            // Photos, the Play Store and ~80% of everything else. Tagging
            // those as "system" buries the inventory under noise. Instead we
            // tag an app as system only when it is BOTH preinstalled AND
            // not user-facing (no launcher intent) AND has not been replaced
            // by a user-installed update. That matches what a human means
            // by "system app" — internal OS components and headless services.
            val pm = context.packageManager
            // When the agent is a Profile Owner the OS hands us ONLY the work
            // profile's package list — the user's personal apps are physically
            // invisible to us (Android BYOD isolation). So every app here is, by
            // definition, a work-profile app. We tag the result with the profile
            // scope + management mode so the admin UI can frame it as such and
            // offer work-profile-aware views without dropping anything.
            val profileScoped = dpm.isProfileOwner()
            val apps = pm.getInstalledApplications(PackageManager.GET_META_DATA)
                .asSequence()
                .mapNotNull { info ->
                    // GET_PERMISSIONS so we can surface, per app, what it requested
                    // and what is actually granted right now. A Device/Profile Owner
                    // is allowed to read this for every package it can see.
                    val pi = runCatching { pm.getPackageInfo(info.packageName, PackageManager.GET_PERMISSIONS) }.getOrNull() ?: return@mapNotNull null
                    val rawSystem    = (info.flags and ApplicationInfo.FLAG_SYSTEM) != 0
                    val updatedSystem = (info.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
                    val launchable   = pm.getLaunchIntentForPackage(info.packageName) != null
                    val isSystem     = rawSystem && !updatedSystem && !launchable
                    // Who installed it (Play, sideload, the DPC, …) — lets the UI
                    // distinguish genuinely provisioned work apps from the OEM
                    // apps the profile inherits. Best-effort: null on old APIs.
                    val installer    = installerOf(pm, info.packageName)
                    mapOf(
                        "package"        to info.packageName,
                        "label"          to pm.getApplicationLabel(info).toString(),
                        "version_name"   to (pi.versionName ?: ""),
                        "version_code"   to pi.versionCodeCompat(),
                        "system"         to isSystem,
                        "preinstalled"   to rawSystem,
                        "updated_system" to updatedSystem,
                        "launchable"     to launchable,
                        "enabled"        to info.enabled,
                        "installer"      to installer,
                        "work_installed" to !rawSystem,   // installed into the profile, not inherited from the OEM image
                        "first_install"  to pi.firstInstallTime,
                        "last_update"    to pi.lastUpdateTime,
                        // Per-app permissions: every permission the app requested,
                        // with its live grant state. Lets the operator drill into
                        // exactly what each app can access.
                        "permissions"    to appPermissions(pi),
                        "perm_count"     to (pi.requestedPermissions?.size ?: 0),
                        "perm_granted"   to grantedCount(pi)
                    )
                }
                .toList()
            mapOf(
                "count"           to apps.size,
                "apps"            to apps,
                "profile_scoped"  to profileScoped,
                "management_mode" to dpm.managementMode(),
                "fetched_at"      to nowIso()
            )
        }

        CommandKind.FETCH_APP_USAGE -> {
            // Time-in-app — the same data Settings / Digital Wellbeing shows,
            // via UsageStatsManager. This is PER-PROFILE by construction: a
            // Profile Owner sees only the work profile's apps; a Device Owner
            // sees the whole (company) device. The OS scopes it, so the admin
            // UI can present each enrollment mode separately without us having
            // to filter here. Needs PACKAGE_USAGE_STATS (usage access).
            val usm = context.getSystemService(UsageStatsManager::class.java)
            if (usm == null || !usageAccessGranted()) {
                mapOf(
                    "usage_access"    to false,
                    "today"           to emptyList<Any>(),
                    "week"            to emptyList<Any>(),
                    "profile_scoped"  to runCatching { dpm.isProfileOwner() }.getOrDefault(false),
                    "management_mode" to dpm.managementMode(),
                    "fetched_at"      to nowIso()
                )
            } else {
                val pm = context.packageManager
                val now = System.currentTimeMillis()
                val startOfToday = java.util.Calendar.getInstance().apply {
                    set(java.util.Calendar.HOUR_OF_DAY, 0)
                    set(java.util.Calendar.MINUTE, 0)
                    set(java.util.Calendar.SECOND, 0)
                    set(java.util.Calendar.MILLISECOND, 0)
                }.timeInMillis
                val weekAgo = now - 7L * 24 * 60 * 60 * 1000

                // queryUsageStats can return several rows per package — sum the
                // foreground time and keep the most recent last-used stamp.
                fun rollup(startMs: Long): List<Map<String, Any?>> {
                    val stats = runCatching {
                        usm.queryUsageStats(UsageStatsManager.INTERVAL_BEST, startMs, now)
                    }.getOrNull().orEmpty()
                    val totalFg = HashMap<String, Long>()
                    val lastUsed = HashMap<String, Long>()
                    for (s in stats) {
                        if (s.totalTimeInForeground <= 0L) continue
                        totalFg[s.packageName] = (totalFg[s.packageName] ?: 0L) + s.totalTimeInForeground
                        lastUsed[s.packageName] = maxOf(lastUsed[s.packageName] ?: 0L, s.lastTimeUsed)
                    }
                    return totalFg.entries
                        .map { (pkg, fg) ->
                            mapOf(
                                "package"             to pkg,
                                "label"               to (runCatching {
                                    pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
                                }.getOrNull() ?: pkg),
                                "total_foreground_ms" to fg,
                                "last_used"           to (lastUsed[pkg] ?: 0L)
                            )
                        }
                        .sortedByDescending { it["total_foreground_ms"] as Long }
                }

                // Per-day screen time for the last 7 days (oldest first) — drives
                // the usage trend chart. One windowed query per day; total is the
                // sum of every package's foreground time that day.
                val dayMs = 24L * 60 * 60 * 1000
                val daily = (0 until 7).map { i ->
                    val dayStart = startOfToday - (6 - i) * dayMs
                    val dayEnd = minOf(dayStart + dayMs, now)
                    val stats = runCatching {
                        usm.queryUsageStats(UsageStatsManager.INTERVAL_BEST, dayStart, dayEnd)
                    }.getOrNull().orEmpty()
                    var total = 0L
                    for (s in stats) if (s.totalTimeInForeground > 0L) total += s.totalTimeInForeground
                    mapOf("date_ms" to dayStart, "total_foreground_ms" to total)
                }

                mapOf(
                    "usage_access"    to true,
                    "today"           to rollup(startOfToday),
                    "week"            to rollup(weekAgo),
                    "daily"           to daily,
                    "profile_scoped"  to runCatching { dpm.isProfileOwner() }.getOrDefault(false),
                    "management_mode" to dpm.managementMode(),
                    "fetched_at"      to nowIso()
                )
            }
        }

        CommandKind.CLEAR_APP_DATA -> {
            val pkg = p.str("package_name")
            dpm.clearApplicationUserData(pkg); null
        }

        CommandKind.CAPTURE_PHOTO -> {
            val lensStr = (p["lens"] as? String)?.uppercase() ?: "BACK"
            val lens = when (lensStr) {
                "FRONT" -> CameraCapture.Lens.FRONT
                else    -> CameraCapture.Lens.BACK
            }
            val withFlash = p.bool("with_flash", false)
            val granted = dpm.grantRuntimePermission(context.packageName, android.Manifest.permission.CAMERA)
            // DPM.setCameraDisabled(true) blocks the camera for ALL apps,
            // including this DPC. Briefly lift it for the capture, then
            // restore — otherwise the admin's "disable_camera" policy makes
            // CAPTURE_PHOTO permanently impossible.
            val cameraWasDisabled = dpm.isCameraDisabled()
            if (cameraWasDisabled) {
                Timber.i("CAPTURE_PHOTO: lifting camera-disabled for capture")
                dpm.setCameraDisabled(false)
            }
            Timber.i("CAPTURE_PHOTO: granted=$granted device_owner=${dpm.isDeviceOwner()} " +
                     "admin_active=${dpm.isAdminActive()} camera_was_disabled=$cameraWasDisabled")
            val capture = try {
                camera.capture(lens, withFlash)
            } finally {
                if (cameraWasDisabled) dpm.setCameraDisabled(true)
            }
            when (val res = capture) {
                is CameraCapture.CameraResult.Error -> error(res.reason)
                is CameraCapture.CameraResult.Success -> {
                    val fileName = "photo_${System.currentTimeMillis()}.jpg"
                    val body = res.jpeg.toRequestBody("image/jpeg".toMediaTypeOrNull())
                    val part = MultipartBody.Part.createFormData("file", fileName, body)
                    val kindBody = "photo".toRequestBody("text/plain".toMediaTypeOrNull())
                    val nameBody = fileName.toRequestBody("text/plain".toMediaTypeOrNull())
                    val resp = api.deviceUpload(part, kindBody, nameBody)
                    if (!resp.isSuccessful) {
                        error("upload failed HTTP ${resp.code()}")
                    }
                    val r = resp.body()!!
                    mapOf(
                        "file_id"  to r.id,
                        "sha256"   to r.sha256,
                        "size"     to r.sizeBytes,
                        "lens"     to lens.name,
                        "width_px"  to res.widthPx,
                        "height_px" to res.heightPx,
                        "captured_at" to nowIso()
                    )
                }
            }
        }

        CommandKind.START_AUDIO_STREAM -> {
            val session = p.str("session_id")
            val segmentSec = (p["segment_sec"] as? Number)?.toInt() ?: 5
            val maxSec = (p["max_sec"] as? Number)?.toInt() ?: 300
            // Auto-grant in DO mode; NOP in DA/none mode (there the user grants
            // RECORD_AUDIO via the in-app Permissions panel).
            dpm.grantRuntimePermission(context.packageName, android.Manifest.permission.RECORD_AUDIO)
            // start() awaits the first segment and returns a failure reason (or
            // null). Surfacing it makes a silent mic failure visible to the
            // server instead of the command falsely reporting success.
            val startErr = audioStream.start(session, segmentSec, maxSec) { bytes, seq ->
                // Name encodes session + zero-padded sequence so the admin UI
                // can group a session and play its segments in order:
                //   audio_<session>_<seq>_<ts>.m4a
                val seqPad = seq.toString().padStart(4, '0')
                val fileName = "audio_${session}_${seqPad}_${System.currentTimeMillis()}.aac"
                val body = bytes.toRequestBody("audio/aac".toMediaTypeOrNull())
                val part = MultipartBody.Part.createFormData("file", fileName, body)
                val kindBody = "audio".toRequestBody("text/plain".toMediaTypeOrNull())
                val nameBody = fileName.toRequestBody("text/plain".toMediaTypeOrNull())
                val resp = api.deviceUpload(part, kindBody, nameBody)
                if (!resp.isSuccessful) {
                    val eb = runCatching { resp.errorBody()?.string() }.getOrNull()?.take(180)
                    Timber.w("audio upload failed HTTP ${resp.code()} seq=$seq body=$eb")
                    // Throw so AudioStreamManager surfaces the failure in the
                    // command result instead of the mic recording into the void.
                    error("upload HTTP ${resp.code()}${if (eb.isNullOrBlank()) "" else ": $eb"}")
                }
            }
            if (startErr != null) error(startErr)
            mapOf(
                "session_id"  to session,
                "segment_sec" to segmentSec,
                "max_sec"     to maxSec,
                "started_at"  to nowIso()
            )
        }

        CommandKind.STOP_AUDIO_STREAM -> {
            val session = p["session_id"] as? String
            audioStream.stop(session)
            mapOf("session_id" to (session ?: "(all)"), "stopped_at" to nowIso())
        }

        CommandKind.SHOW_MESSAGE -> {
            val title = (p["title"] as? String)?.takeIf { it.isNotBlank() } ?: "Message from IT"
            val message = ((p["message"] as? String) ?: (p["text"] as? String)).orEmpty()
            if (message.isBlank()) error("message is empty")
            showMessagePopup(title, message)
            mapOf("shown" to true, "title" to title, "at" to nowIso())
        }

        CommandKind.SET_FLASHLIGHT -> {
            val on = p.bool("on", true)
            val ok = camera.setTorch(on)
            if (!ok) error("torch toggle failed (no flash unit or in use)")
            mapOf("on" to on, "at" to nowIso())
        }

        CommandKind.PLAY_SOUND -> {
            val durationMs = (p["duration_ms"] as? Number)?.toLong() ?: 10_000L
            buzzer.ringFor(durationMs)
            mapOf("ringing_ms" to durationMs, "at" to nowIso())
        }

        CommandKind.GET_LOCATION -> {
            // As Device Owner, leave nothing to chance: grant foreground +
            // background location and force device location services ON before
            // asking for a fix. This is what makes GET_LOCATION work on OEMs
            // (OnePlus/Oppo) that ship with location off or block background
            // access. All of these no-op gracefully in Device Admin mode.
            dpm.grantRuntimePermission(context.packageName, android.Manifest.permission.ACCESS_FINE_LOCATION)
            dpm.grantRuntimePermission(context.packageName, android.Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            dpm.enforceLocationOn()
            // Be patient on an explicit locate request: a cold GPS lock can take
            // 20s+ (no network-location fallback on some OEMs). The server command
            // timeout is minutes, so this is safe. The heartbeat keeps its short
            // timeout since it only piggy-backs a cached fix.
            val s = locator.get(timeoutMs = 25_000L)
            if (s == null) {
                val locOn = dpm.isLocationEnabled()
                error(
                    if (!locOn)
                        "location services are OFF on the device" +
                        (if (dpm.isDeviceOwner()) " and could not be force-enabled" else " (enable location, or provision as Device Owner to force it on)")
                    else
                        "location is on but no provider returned a fix yet — move the device where it can see sky/Wi-Fi and retry"
                )
            }
            mapOf(
                "latitude"   to s.latitude,
                "longitude"  to s.longitude,
                "accuracy_m" to s.accuracyM,
                "provider"   to s.provider,
                "fix_at"     to s.timestamp,
                "fresh"      to s.isFresh
            )
        }

        CommandKind.COLLECT_LOGS -> {
            // Reading the system logcat requires READ_LOGS, which user apps
            // can't hold. We return a best-effort device-state snapshot the
            // admin can correlate against server-side audit; for full logs
            // the admin must `adb shell logcat` against a debug device.
            val s = collector.snapshot()
            val ig = integrity.snapshot()
            mapOf(
                "note"        to "Full logcat requires READ_LOGS (debug-only). " +
                                 "Returning runtime state snapshot instead.",
                "uptime_ms"   to SystemClock.elapsedRealtime(),
                "boot_time"   to (System.currentTimeMillis() - SystemClock.elapsedRealtime()),
                "battery_pct" to s.batteryPct,
                "network"     to s.network,
                "rooted"      to ig.rooted,
                "agent"       to mapOf(
                    "version" to agentVersionName(),
                    "version_code" to agentVersionCode(),
                    "device_owner" to dpm.isDeviceOwner(),
                    "admin_active" to dpm.isAdminActive()
                ),
                "fetched_at"  to nowIso()
            )
        }
    }

    private suspend fun complete(cmd: CommandDto, success: Boolean, result: Map<String, Any?>?, error: String?) {
        if (!auth.isEnrolled()) return
        // Retry the ack with backoff: the side-effect already ran, so a transient
        // network failure here (e.g. mid Wi-Fi switch) must not leave the command
        // stuck "dispatched" on the server until it times out. 4 tries over ~15s.
        val dto = CommandResultDto(success = success, result = result, error = error)
        var delayMs = 1_000L
        repeat(4) { attempt ->
            val ok = runCatching { api.postCommandResult(cmd.id, dto) }
                .onFailure { Timber.w(it, "result post failed for ${cmd.id} (attempt ${attempt + 1})") }
                .isSuccess
            if (ok) return
            kotlinx.coroutines.delay(delayMs)
            delayMs *= 2
        }
    }

    private fun nowIso(): String =
        java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC).toString()

    /**
     * Surfaces an admin message on the device: a high-importance heads-up
     * notification with a full-screen intent (pops over the screen, shows when
     * locked), plus a best-effort direct launch of the dialog activity (which
     * works as Device Owner / when the app is foregrounded). Between the two the
     * message reaches the user across owner / admin / enrolled-only modes.
     */
    private fun showMessagePopup(title: String, message: String) {
        val nm = context.getSystemService(android.app.NotificationManager::class.java)
        val chId = "mdm_message"
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            val ch = android.app.NotificationChannel(chId, "Messages",
                android.app.NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Messages from your IT administrator"
            }
            nm?.createNotificationChannel(ch)
        }
        val actIntent = android.content.Intent(context, MessageActivity::class.java).apply {
            addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            putExtra("title", title)
            putExtra("message", message)
        }
        val piFlags = android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
        val pi = android.app.PendingIntent.getActivity(context, message.hashCode(), actIntent, piFlags)
        val notif = androidx.core.app.NotificationCompat.Builder(context, chId)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(androidx.core.app.NotificationCompat.BigTextStyle().bigText(message))
            .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH)
            .setCategory(androidx.core.app.NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setFullScreenIntent(pi, true)
            .setContentIntent(pi)
            .build()
        runCatching { nm?.notify(0xCAF1, notif) }
        runCatching { context.startActivity(actIntent) }
    }

    @Suppress("DEPRECATION")
    private fun PackageInfo.versionCodeCompat(): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) longVersionCode else versionCode.toLong()

    /** Every permission an app requested + whether it is currently granted.
     *  Names are stripped of the verbose `android.permission.` prefix to keep
     *  the inventory payload compact. Empty for apps that request nothing. */
    private fun appPermissions(pi: PackageInfo): List<Map<String, Any?>> {
        val names = pi.requestedPermissions ?: return emptyList()
        val flags = pi.requestedPermissionsFlags
        return names.mapIndexed { i, name ->
            val granted = flags != null && i < flags.size &&
                (flags[i] and PackageInfo.REQUESTED_PERMISSION_GRANTED) != 0
            mapOf(
                "name"    to name.removePrefix("android.permission."),
                "granted" to granted
            )
        }
    }

    private fun grantedCount(pi: PackageInfo): Int {
        val flags = pi.requestedPermissionsFlags ?: return 0
        return flags.count { (it and PackageInfo.REQUESTED_PERMISSION_GRANTED) != 0 }
    }

    /** The MDM agent's OWN access on this device: runtime permissions, special
     *  access toggles and admin role — each with its live grant state. Drives
     *  the "Agent permissions" panel shown for every device. */
    private fun mdmPermissions(): List<Map<String, Any?>> {
        val out = mutableListOf<Map<String, Any?>>()
        fun add(name: String, granted: Boolean, kind: String) =
            out.add(mapOf("name" to name, "granted" to granted, "kind" to kind))
        fun runtimeGranted(perm: String) =
            runCatching { context.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED }.getOrDefault(false)

        // ---- runtime (dangerous) permissions the agent declares ----
        add("Camera",              runtimeGranted(android.Manifest.permission.CAMERA), "runtime")
        add("Microphone",          runtimeGranted(android.Manifest.permission.RECORD_AUDIO), "runtime")
        add("Fine location",       runtimeGranted(android.Manifest.permission.ACCESS_FINE_LOCATION), "runtime")
        add("Background location", runtimeGranted(android.Manifest.permission.ACCESS_BACKGROUND_LOCATION), "runtime")
        add("Phone state",         runtimeGranted(android.Manifest.permission.READ_PHONE_STATE), "runtime")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            add("Notifications",   runtimeGranted(android.Manifest.permission.POST_NOTIFICATIONS), "runtime")

        // ---- special-access toggles (each a separate Settings screen) ----
        add("Display over apps", runCatching { android.provider.Settings.canDrawOverlays(context) }.getOrDefault(false), "special")
        add("Install unknown apps",
            runCatching { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.packageManager.canRequestPackageInstalls() else true }.getOrDefault(false), "special")
        add("Ignore battery optimization",
            runCatching {
                val pm = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
                pm.isIgnoringBatteryOptimizations(context.packageName)
            }.getOrDefault(false), "special")
        add("Usage access", usageAccessGranted(), "special")
        add("Notifications enabled",
            runCatching {
                (context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager).areNotificationsEnabled()
            }.getOrDefault(false), "special")

        // ---- admin role ----
        add("Device Owner",        runCatching { dpm.isDeviceOwner() }.getOrDefault(false), "admin")
        add("Profile Owner",       runCatching { dpm.isProfileOwner() }.getOrDefault(false), "admin")
        add("Device Admin active", runCatching { dpm.isAdminActive() }.getOrDefault(false), "admin")
        return out
    }

    private fun usageAccessGranted(): Boolean = runCatching {
        val ops = context.getSystemService(Context.APP_OPS_SERVICE) as android.app.AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
            ops.unsafeCheckOpNoThrow(android.app.AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), context.packageName)
        else
            @Suppress("DEPRECATION")
            ops.checkOpNoThrow(android.app.AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), context.packageName)
        mode == android.app.AppOpsManager.MODE_ALLOWED
    }.getOrDefault(false)

    /** Installer package that provisioned an app (Play, the DPC, a sideload),
     *  or null when unknown / on APIs that don't expose it. Best-effort: any
     *  failure (package gone, no permission) collapses to null. */
    @Suppress("DEPRECATION")
    private fun installerOf(pm: PackageManager, pkg: String): String? = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
            pm.getInstallSourceInfo(pkg).installingPackageName
        else
            pm.getInstallerPackageName(pkg)
    }.getOrNull()

    // ---------- payload helpers ----------
    private fun Map<String, Any?>.str(k: String): String =
        (this[k] as? String) ?: error("missing string '$k'")
    private fun Map<String, Any?>.int(k: String): Int =
        (this[k] as? Number)?.toInt() ?: error("missing int '$k'")
    private fun Map<String, Any?>.bool(k: String, default: Boolean): Boolean =
        (this[k] as? Boolean) ?: default

    private companion object { const val AGENT_VERSION = "1.0.0" }
}

package com.mdm.policy

import com.mdm.core.admin.DevicePolicyController
import com.mdm.core.admin.Restriction
import com.mdm.networking.auth.TokenStore
import kotlinx.serialization.json.Json
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Walks a [PolicySpec] and reflects it onto the device via [DevicePolicyController].
 *
 * Field-level semantics inside a single spec:
 *   - null  → leave the previous policy value alone
 *   - false → explicitly clear / allow
 *   - true  → explicitly enforce / disable
 *
 * Cross-apply semantics (the part that broke before this rewrite):
 *   We persist the last-applied spec to TokenStore. On every apply() we
 *   compute the diff prev→current. Any field that was *enforced* in prev
 *   (e.g. disable_camera=true) but is now null/absent in current must be
 *   explicitly *reset* to baseline (disable_camera=false) — otherwise the
 *   "null = preserve" semantic strands the device in the previous state
 *   forever after an unassign.
 *
 * App install/uninstall are delegated to AppInstaller below — Device Owner
 * install flows go through PackageInstaller sessions, not DPM directly.
 */
@Singleton
class PolicyApplier @Inject constructor(
    private val dpm: DevicePolicyController,
    private val tokens: TokenStore
) {
    private val json = Json { ignoreUnknownKeys = true; isLenient = false; encodeDefaults = true }

    fun apply(spec: PolicySpec) {
        Timber.i("Applying policy spec")

        // Decode the previously-applied spec (if any) so we can compute the
        // diff. A failed parse is treated as "no previous spec" — better to
        // re-enforce everything than to skip the reconcile entirely.
        val prev: PolicySpec? = tokens.lastAppliedSpecJson()
            ?.let { runCatching { json.decodeFromString(PolicySpec.serializer(), it) }
                .onFailure { Timber.w(it, "prior-spec parse failed; treating as no-prev") }
                .getOrNull() }

        // Reset stage: any field that was enforced last time but is gone now
        // must be explicitly rolled back. We do this BEFORE applying the new
        // spec so the new spec's explicit "true" still wins.
        if (prev != null) resetStrandedFields(prev, spec)

        // Apply stage: standard projection of the new spec onto the device.
        spec.restrictions?.let(::applyRestrictions)
        spec.password?.let(::applyPassword)
        spec.network?.let(::applyNetwork)
        spec.apps?.let(::applyApps)
        spec.system_update?.let(::applySystemUpdate)
        spec.certificates.forEach(::applyCertificate)
        applySecurity(spec.security)
        spec.work_profile?.let(::applyWorkProfile)
        spec.managed_app_configs.forEach { dpm.setApplicationRestrictions(it.package_name, it.config) }

        // Persist conditional-access state so the heartbeat loop can suspend the
        // work apps while non-compliant without re-fetching the policy. The app
        // set is the work allowlist (apps.install).
        tokens.setConditionalSuspend(
            enabled = spec.work_profile?.suspend_on_noncompliant == true,
            apps = spec.apps?.install?.map { it.package_name } ?: emptyList()
        )

        // Persist what we just enforced so the NEXT apply() can diff against it.
        runCatching { tokens.setLastAppliedSpecJson(json.encodeToString(PolicySpec.serializer(), spec)) }
            .onFailure { Timber.w(it, "could not persist last-applied spec") }
    }

    /**
     * For every field that was set in [prev] but null/absent in [next], call
     * the matching device-side reset. The new spec's apply path then puts
     * back anything still in effect.
     */
    private fun resetStrandedFields(prev: PolicySpec, next: PolicySpec) {
        // ---- restrictions ----
        val pr = prev.restrictions
        val nr = next.restrictions
        // disable_camera: cleared if prev set it true and next doesn't mention it.
        if (pr?.disable_camera != null && nr?.disable_camera == null) {
            Timber.i("reset: lifting disable_camera (was ${pr.disable_camera}, now absent)")
            dpm.setCameraDisabled(false)
        }
        if (pr?.disable_screen_capture != null && nr?.disable_screen_capture == null) {
            Timber.i("reset: lifting disable_screen_capture")
            dpm.setScreenCaptureDisabled(false)
        }
        // Each individual UserRestriction.
        data class RB(val r: Restriction, val pv: Boolean?, val nv: Boolean?)
        val rs = listOf(
            RB(Restriction.DisableUSBFileTransfer, pr?.disable_usb_file_transfer, nr?.disable_usb_file_transfer),
            RB(Restriction.DisableBluetooth,       pr?.disable_bluetooth,         nr?.disable_bluetooth),
            RB(Restriction.DisableNFC,             pr?.disable_nfc,               nr?.disable_nfc),
            RB(Restriction.DisableHotspot,         pr?.disable_hotspot,           nr?.disable_hotspot),
            RB(Restriction.DisableLocation,        pr?.disable_location,          nr?.disable_location),
            RB(Restriction.DisableUnknownSources,  pr?.disable_unknown_sources,   nr?.disable_unknown_sources),
            RB(Restriction.DisableAccessibility,   pr?.disable_accessibility,     nr?.disable_accessibility),
            RB(Restriction.DisableFactoryReset,    pr?.disable_factory_reset,     nr?.disable_factory_reset),
            RB(Restriction.DisableSafeBoot,        pr?.disable_safe_boot,         nr?.disable_safe_boot),
            RB(Restriction.DisableAddUser,         pr?.disable_add_user,          nr?.disable_add_user)
        )
        for (rb in rs) {
            if (rb.pv != null && rb.nv == null) {
                Timber.i("reset: lifting ${rb.r}")
                dpm.setRestriction(rb.r, false)
            }
        }

        // ---- security (surveillance toggles) ----
        if (prev.security?.capture_on_unlock == true && next.security?.capture_on_unlock != true) {
            Timber.i("reset: clearing capture_on_unlock")
            tokens.setCaptureOnUnlock(false)
        }

        // ---- apps: the existing applyApps already reconciles blocklist
        // additions/removals; here we just need to handle the case where the
        // whole `apps` block disappears.
        if (prev.apps != null && next.apps == null) {
            Timber.i("reset: apps block disappeared; clearing blocklists")
            for (pkg in tokens.appBlocklist()) {
                dpm.setApplicationHidden(pkg, false)
                dpm.setUninstallBlocked(pkg, false)
            }
            tokens.setAppBlocklist(emptyList())
            dpm.setChromeUrlBlocklist(emptyList())
            tokens.setUrlBlocklist(emptyList())
        }

        // ---- network ----
        if (prev.network?.always_on_vpn_package != null && next.network?.always_on_vpn_package == null) {
            Timber.i("reset: clearing always-on VPN")
            runCatching { dpm.setAlwaysOnVpn(null, false) }
                .onFailure { Timber.w(it, "setAlwaysOnVpn(null) failed (may not be supported on this admin)") }
        }
        if (prev.network?.proxy_host != null && next.network?.proxy_host == null) {
            Timber.i("reset: clearing global proxy")
            runCatching { dpm.setGlobalProxy(null, 0, emptyList()) }
                .onFailure { Timber.w(it, "setGlobalProxy(null) failed") }
        }

        // ---- work profile (Profile Owner only) ----
        if (dpm.isProfileOwner()) {
            // Un-suspend any work apps that were suspended last time but aren't now.
            val prevSusp = prev.work_profile?.suspended_packages ?: emptyList()
            val nextSusp = next.work_profile?.suspended_packages ?: emptyList()
            val toUnsuspend = prevSusp - nextSusp.toSet()
            if (toUnsuspend.isNotEmpty()) {
                Timber.i("reset: un-suspending ${toUnsuspend.size} work app(s)")
                dpm.setPackagesSuspended(toUnsuspend, false)
            }
            // max-time-off cleared → lift the auto-pause.
            if (prev.work_profile?.max_time_off_minutes != null && next.work_profile?.max_time_off_minutes == null) {
                dpm.setManagedProfileMaximumTimeOff(0)
            }
            // Whole block disappeared → lift every restriction it could have set.
            if (prev.work_profile != null && next.work_profile == null) {
                Timber.i("reset: work_profile block disappeared; clearing PO restrictions")
                dpm.setScreenCaptureDisabled(false)
                dpm.setRestriction(Restriction.ClipboardIsolation, false)
                dpm.setRestriction(Restriction.BlockExternalSharing, false)
                dpm.setRestriction(Restriction.BlockAppInstall, false)
                dpm.setRestriction(Restriction.BlockUninstall, false)
                dpm.setRestriction(Restriction.BlockProfileRemoval, false)
                dpm.setSeparateWorkChallenge(false)
                dpm.setCrossProfileContactsSearchDisabled(false)
                dpm.setCrossProfileCallerIdDisabled(false)
                dpm.setCrossProfileCalendarDisabled(false)
            }
        }
    }

    /**
     * Surveillance toggles. Persisted to TokenStore so the receiver-based
     * subsystems (ActivityMonitor) can read them at the instant the relevant
     * system event fires without having to re-fetch the policy.
     */
    private fun applySecurity(s: SecurityPolicy?) {
        // Null → leave previous value untouched. Explicit false → disable.
        if (s != null) {
            tokens.setCaptureOnUnlock(s.capture_on_unlock)
            Timber.i("Security: capture_on_unlock = ${s.capture_on_unlock}")
        }
    }

    private fun applyRestrictions(r: Restrictions) {
        // Camera + capture have dedicated DPM setters distinct from UserRestrictions.
        r.disable_camera?.let { dpm.setCameraDisabled(it) }
        r.disable_screen_capture?.let { dpm.setScreenCaptureDisabled(it) }

        // Generic UserRestriction dispatcher — null preserves prior state.
        mapOf(
            Restriction.DisableUSBFileTransfer to r.disable_usb_file_transfer,
            Restriction.DisableBluetooth      to r.disable_bluetooth,
            Restriction.DisableNFC            to r.disable_nfc,
            Restriction.DisableHotspot        to r.disable_hotspot,
            Restriction.DisableLocation       to r.disable_location,
            Restriction.DisableUnknownSources to r.disable_unknown_sources,
            Restriction.DisableAccessibility  to r.disable_accessibility,
            Restriction.DisableFactoryReset   to r.disable_factory_reset,
            Restriction.DisableSafeBoot       to r.disable_safe_boot,
            Restriction.DisableAddUser        to r.disable_add_user
        ).forEach { (key, v) -> if (v != null) dpm.setRestriction(key, v) }
    }

    private fun applyPassword(p: PasswordPolicy) {
        p.complexity?.let { dpm.setPasswordComplexity(it) }
        p.minimum_length?.let { dpm.setMinimumPasswordLength(it) }
        p.max_failed_for_wipe?.let { dpm.setMaxFailedPasswordsForWipe(it) }
        p.expiration_ms?.let { dpm.setPasswordExpirationTimeoutMs(it) }
        p.inactivity_lock_seconds?.let { dpm.setInactivityLockSeconds(it) }
    }

    private fun applyNetwork(n: NetworkPolicy) {
        n.always_on_vpn_package?.let { dpm.setAlwaysOnVpn(it, n.always_on_vpn_lockdown) }
        if (n.proxy_host != null && n.proxy_port != null) {
            dpm.setGlobalProxy(n.proxy_host, n.proxy_port, n.proxy_exclusions)
        }
    }

    private fun applyApps(a: AppPolicy) {
        // Reconcile against the previous blocklist so apps that have been
        // REMOVED from the policy are re-shown — without this, dropping a
        // package from the blocklist leaves it permanently hidden until
        // CLEAR_POLICY fires.
        val previous = tokens.appBlocklist().toSet()
        val current  = a.blocklist.toSet()
        for (pkg in previous - current) {
            dpm.setApplicationHidden(pkg, false)
            dpm.setUninstallBlocked(pkg, false)
        }
        for (pkg in current) {
            dpm.setApplicationHidden(pkg, true)
            dpm.setUninstallBlocked(pkg, true)
        }
        tokens.setAppBlocklist(a.blocklist)

        // Chrome managed config: pushes a URLBlocklist into the Chrome
        // app's restrictions bundle. The Chrome enterprise schema is
        // honoured by AOSP Chrome 36+; AGSA / web-view-only stacks
        // silently ignore it. Same call works for Edge / Brave when
        // they pick up Chromium's policy schema. Always-pushed (even if
        // empty) so toggling the list off actually unblocks.
        dpm.setChromeUrlBlocklist(a.url_blocklist)
        tokens.setUrlBlocklist(a.url_blocklist)
        // Install / uninstall flow: actual side-effects live in command-executor
        // (PackageInstaller sessions need a foreground service context). The
        // policy applier records intent; CommandExecutor enacts it via a
        // synthetic INSTALL_APP/UNINSTALL_APP command when the spec changes.
        if (a.install.isNotEmpty() || a.uninstall.isNotEmpty()) {
            Timber.d("Policy lists ${a.install.size} installs, ${a.uninstall.size} uninstalls — " +
                     "delegated to CommandExecutor")
        }
    }

    private fun applySystemUpdate(s: SystemUpdatePolicy) {
        dpm.setSystemUpdatePolicy(s.mode, s.window_start_min, s.window_end_min)
    }

    /**
     * Projects the work-profile block onto the managed profile. Only meaningful
     * when the agent is a Profile Owner; the underlying DevicePolicyController
     * calls no-op otherwise. null fields are skipped (preserve current value).
     */
    private fun applyWorkProfile(wp: WorkProfilePolicy) {
        if (!dpm.isProfileOwner()) {
            Timber.i("work_profile block present but agent is not a Profile Owner — skipping")
            return
        }
        wp.disable_screenshot?.let { dpm.setScreenCaptureDisabled(it) }
        wp.clipboard_isolation?.let { dpm.setRestriction(Restriction.ClipboardIsolation, it) }
        wp.block_external_sharing?.let { dpm.setRestriction(Restriction.BlockExternalSharing, it) }
        wp.block_app_install?.let { dpm.setRestriction(Restriction.BlockAppInstall, it) }
        wp.block_uninstall?.let { dpm.setRestriction(Restriction.BlockUninstall, it) }
        wp.block_profile_removal?.let { dpm.setRestriction(Restriction.BlockProfileRemoval, it) }
        wp.separate_work_challenge?.let { dpm.setSeparateWorkChallenge(it) }
        wp.disable_cross_profile_contacts?.let { dpm.setCrossProfileContactsSearchDisabled(it) }
        wp.disable_cross_profile_caller_id?.let { dpm.setCrossProfileCallerIdDisabled(it) }
        wp.disable_cross_profile_calendar?.let { dpm.setCrossProfileCalendarDisabled(it) }
        // Phase 2/3: app suspension + auto-pause scheduling.
        if (wp.suspended_packages.isNotEmpty()) dpm.setPackagesSuspended(wp.suspended_packages, true)
        wp.max_time_off_minutes?.let { dpm.setManagedProfileMaximumTimeOff(it) }
    }

    private fun applyCertificate(c: Certificate) {
        val pem = runCatching { android.util.Base64.decode(c.pem_base64, android.util.Base64.DEFAULT) }
            .getOrElse { Timber.w(it, "bad cert base64: ${c.id}"); return }
        if (c.install) dpm.installCaCert(pem) else dpm.removeCaCert(pem)
    }
}

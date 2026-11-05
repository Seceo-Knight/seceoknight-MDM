package com.mdm.agent.ui

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mdm.command.CommandService
import com.mdm.core.admin.DevicePolicyController
import com.mdm.core.admin.ProvisioningStash
import com.mdm.enrollment.EnrollmentManager
import com.mdm.networking.ConnectionMonitor
import com.mdm.networking.api.MdmApi
import com.mdm.networking.auth.AuthRepository
import com.mdm.networking.auth.DebugUnlock
import com.mdm.networking.auth.TokenStore
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import timber.log.Timber
import okhttp3.OkHttpClient
import okhttp3.Request
import javax.inject.Inject
import javax.inject.Named

/**
 * Decides which screen to render. Admin/owner rights are NOT required to use the
 * app: a device can enroll with no admin role at all ("enrolled-only" mode —
 * read-only telemetry + whatever permissions the user grants). Device Admin and
 * Device Owner are optional capability upgrades surfaced on the home screen, not
 * gates. The only thing needed to leave the enrollment screen is valid device
 * credentials.
 */
@HiltViewModel
class MainViewModel @Inject constructor(
    @ApplicationContext private val appContext: Context,
    private val dpm: DevicePolicyController,
    private val enrollment: EnrollmentManager,
    private val auth: AuthRepository,
    private val tokens: TokenStore,
    private val api: MdmApi,
    private val connection: ConnectionMonitor,
    // Clean client (no BaseUrlInterceptor / token header) — used for the raw
    // reachability stage of the repoint probe so it hits the literal URL and
    // can't be misdirected by stale config.
    @Named("download") private val rawClient: OkHttpClient
) : ViewModel() {

    // ----- hidden debug config panel (server-address repoint) -----

    /** True once the server has delivered a debug-unlock hash (panel enabled). */
    fun debugUnlockConfigured(): Boolean = !tokens.debugUnlockHash().isNullOrBlank()

    /** Verify the operator's typed password locally against the cached hash. */
    fun verifyDebugPassword(input: String): Boolean =
        DebugUnlock.verify(input, tokens.debugUnlockHash())

    /** Current server URL shown (pre-filled) in the panel. */
    fun currentServerUrl(): String = tokens.serverUrl().orEmpty()

    /** Live, real connection status (driven by the heartbeat loop) for the UI. */
    val connectionStatus: StateFlow<ConnectionMonitor.Status> = connection.status

    /** Outcome of a server-address repoint, surfaced honestly in the Dev Console.
     *  [target] is the exact URL probed so the panel can show where it tried. */
    sealed interface RepointResult {
        /** Reached the new server and it authenticated this device. */
        data class Ok(val target: String) : RepointResult
        /** Reached the server (TCP+HTTP) but it rejected this device's token
         *  (likely a fresh DB / rotated secret) — re-enroll. */
        data class Rejected(val code: Int, val target: String) : RepointResult
        /** Could not even open an HTTP connection (wrong port, blocked, proxy,
         *  cleartext policy). [detail] is the raw exception so the cause is visible. */
        data class Unreachable(val target: String, val detail: String) : RepointResult
        /** The text typed isn't a usable URL. */
        data object BadUrl : RepointResult
    }

    /**
     * Repoint the agent at a new server address AND verify it actually works
     * before claiming success. Persisting the URL is enough for the running
     * heartbeat/poll loops to switch hosts (the BaseUrlInterceptor reads it per
     * request); we punch an immediate tick, then run a TWO-STAGE probe so a
     * failure points at the real cause:
     *   1. raw reachability — a clean-client GET to the literal URL (no token, no
     *      interceptor), proving the phone can open an HTTP connection there;
     *   2. auth — the normal authenticated call, distinguishing "token rejected".
     * [onResult] is delivered on Main.
     */
    fun applyServerConfig(rawUrl: String, onResult: (RepointResult) -> Unit) {
        val clean = normalizeServerUrl(rawUrl)
        if (clean == null) { onResult(RepointResult.BadUrl); return }
        tokens.setServerUrl(clean)
        android.net.Uri.parse(clean).host?.takeIf { it.isNotBlank() }?.let { tokens.setMqttHost(it) }
        viewModelScope.launch {
            // Probe FIRST, on its own, so it isn't racing the heartbeat for the
            // single refresh mutex (which on a cold connection can make the probe
            // time out and look like a rejection). Then start the background loop
            // to reconnect regardless of the probe's verdict.
            val result = probeServer(clean)
            // Hard-restart the agent's connection loops (not just a tick) so they
            // tear down any stuck/frozen state and re-establish against the new URL
            // — the in-process equivalent of the reboot that was needed before.
            CommandService.reconnect(appContext)
            onResult(result)
        }
    }

    /**
     * Two-stage, HARD-BOUNDED probe of [base] (already normalized + stored).
     * Stage 1 uses the clean client against the LITERAL url so the result can't be
     * confounded by stale stored config or a silent interceptor fallback — if this
     * fails, the phone genuinely can't open a connection to that host:port and the
     * exact exception is reported. Stage 2 only then checks auth.
     */
    private suspend fun probeServer(base: String): RepointResult {
        val target = "$base/api/v1/policies/assigned"
        // Stage 1 — raw reachability (no token, no host rewrite). Any HTTP status
        // (even 401) proves the connection opened.
        try {
            kotlinx.coroutines.withTimeout(PROBE_TIMEOUT_MS) {
                val req = Request.Builder().url(target).get().build()
                withContext(Dispatchers.IO) { rawClient.newCall(req).execute() }.use { it.code }
            }
        } catch (t: kotlinx.coroutines.TimeoutCancellationException) {
            return RepointResult.Unreachable(target, "no response in ${PROBE_TIMEOUT_MS / 1000}s (connection never opened)")
        } catch (c: kotlinx.coroutines.CancellationException) {
            // The probe coroutine itself was cancelled (panel dismissed / VM cleared) —
            // that's not a reachability verdict, so propagate instead of reporting a
            // bogus "StandaloneCoroutine was cancelled" as the failure detail.
            throw c
        } catch (t: Throwable) {
            return RepointResult.Unreachable(target, t.message?.take(160) ?: t::class.java.simpleName)
        }
        // Stage 2 — reachable; does this device still AUTHENTICATE? The call below
        // runs through the proactive + reactive refresh path. refreshNow() only
        // wipes credentials when /auth/refresh itself returns 401 — i.e. the
        // refresh token is genuinely dead and re-enrollment is truly required.
        // So the honest signal for "must re-enroll" is whether the credentials
        // SURVIVED the call (auth.isEnrolled()), NOT the HTTP status of a single
        // request, and certainly NOT a timeout — a cold server / fresh ARP right
        // after an IP change is slow to answer, not a rejection. (Previously any
        // timeout here was reported as "rejected — re-enroll", the false alarm
        // that kept telling users to wipe a perfectly healthy device.)
        return try {
            val resp = kotlinx.coroutines.withTimeout(AUTH_PROBE_TIMEOUT_MS) { api.getAssignedPolicy() }
            when {
                // Auth refused AND the refresh token was wiped → genuinely dead → re-enroll.
                (resp.code() == 401 || resp.code() == 403) && !auth.isEnrolled() ->
                    RepointResult.Rejected(resp.code(), target)
                // 2xx, 304, 404 ("no policy assigned" still means authenticated!),
                // or a 401 the refresh already recovered from → device is accepted.
                else -> RepointResult.Ok(target)
            }
        } catch (t: kotlinx.coroutines.TimeoutCancellationException) {
            // Reachable but slow. The background loop keeps authenticating; only a
            // wiped credential set means the device must re-enroll.
            if (auth.isEnrolled()) RepointResult.Ok(target)
            else RepointResult.Rejected(0, target)
        } catch (c: kotlinx.coroutines.CancellationException) {
            throw c   // external cancellation — not an auth verdict
        } catch (t: Throwable) {
            // A network blip during the authenticated call is not a rejection.
            if (auth.isEnrolled())
                RepointResult.Unreachable(target, t.message?.take(160) ?: t::class.java.simpleName)
            else RepointResult.Rejected(0, target)
        }
    }

    /**
     * "Fully flush" — wipe ALL local agent state (credentials, server URL, debug
     * password, MQTT + policy cache) and drop the app back to the enrollment
     * screen. This is the dev-panel's hard-reset escape hatch for when the device
     * is wedged "enrolled" with credentials the server no longer accepts (e.g. a
     * refresh-token desync after a long offline window) and so never falls back to
     * enrollment on its own. After this the device re-enrolls from scratch — which
     * re-delivers the debug-unlock password too, so the panel returns. We set the
     * state directly (not via refresh()) so the switch to the enrollment screen is
     * immediate even though the wipe ran here.
     */
    fun fullyFlush() {
        runCatching { appContext.stopService(android.content.Intent(appContext, CommandService::class.java)) }
        auth.clear() // -> TokenStore.clear(): removes every persisted key
        _error.value = null
        _state.value = UiState.NotEnrolled
    }

    /**
     * Hard-restart the agent PROCESS — the in-app equivalent of rebooting the
     * phone, without touching any credentials or config. This is the reliable
     * recovery when an in-process reconnect ([CommandService.reconnect]) can't
     * shake a wedged connection after a server-address change: relaunch the
     * launcher activity in a fresh task, then kill this process. START_STICKY +
     * the relaunch bring CommandService back up clean — new sockets to the new
     * IP and a fresh [ConnectionMonitor] (so any stale error clears immediately).
     */
    fun restartApp() {
        val launchComponent = appContext.packageManager
            .getLaunchIntentForPackage(appContext.packageName)?.component
            ?: android.content.ComponentName(appContext, "com.mdm.agent.MainActivity")
        runCatching {
            appContext.startActivity(android.content.Intent.makeRestartActivityTask(launchComponent))
        }.onFailure { Timber.w(it, "restartApp: relaunch failed; exiting anyway") }
        // The startActivity request is dispatched to ActivityManager over binder
        // before we return, so it survives the exit and the app comes back up.
        Runtime.getRuntime().exit(0)
    }

    /**
     * "Remove agent" — fully uninstall the MDM agent from this device, the
     * Dev Console's hard removal (distinct from [fullyFlush], which only wipes
     * local state to force a re-enroll). Order matters:
     *   1. While we still hold valid credentials, BEST-EFFORT tell the server the
     *      agent is being removed so the dashboard soft-retires this device and
     *      stops showing it as managed. Hard-bounded so a dead/unreachable server
     *      can't block the local removal — if the device is offline it's simply
     *      skipped (the server will mark it offline once heartbeats stop anyway).
     *   2. Stop the foreground service.
     *   3. Relinquish admin/owner so the package becomes uninstallable, then:
     *        - Profile Owner (BYOD): self-wipe the work profile, which removes the
     *          profile and the agent inside it (there's nothing to "uninstall");
     *        - Device Owner / Admin / none: drop the roles and launch the system
     *          uninstaller for our package.
     *   4. Clear local credentials and drop to the enrollment screen.
     */
    fun removeAgent() {
        _busy.value = true; _error.value = null
        viewModelScope.launch {
            // 1. Notify the server while the access token is still valid.
            val notified = runCatching {
                withTimeoutOrNull(REMOVE_NOTIFY_TIMEOUT_MS) {
                    val resp = api.unenroll()
                    resp.isSuccessful || resp.code() == 404 // 404 = already gone server-side
                }
            }.getOrNull() ?: false
            if (notified) Timber.i("server notified of agent removal")
            else Timber.w("could not notify server of removal (offline?) — continuing")

            // 2. Stop the agent service.
            runCatching { appContext.stopService(android.content.Intent(appContext, CommandService::class.java)) }

            // 3. Relinquish privileges + remove.
            if (dpm.isProfileOwner()) {
                auth.clear()
                _state.value = UiState.NotEnrolled
                dpm.wipeProfile() // removes the work profile (agent included)
            } else {
                dpm.clearDeviceOwner() // no-op if not device owner
                dpm.deactivateAdmin()  // no-op if not an active admin
                auth.clear()
                _state.value = UiState.NotEnrolled
                val uninstall = android.content.Intent(
                    android.content.Intent.ACTION_DELETE,
                    android.net.Uri.parse("package:${appContext.packageName}")
                ).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                runCatching { appContext.startActivity(uninstall) }
                    .onFailure { _error.value = "Couldn't launch uninstaller: ${it.message ?: "unknown"}" }
            }
            _busy.value = false
        }
    }

    /** Trim, default a missing scheme to http://, and require a real host. */
    private fun normalizeServerUrl(raw: String): String? {
        var s = raw.trim().trimEnd('/')
        if (s.isBlank()) return null
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
        val host = android.net.Uri.parse(s).host
        return if (host.isNullOrBlank()) null else s
    }

    sealed interface UiState {
        data object NotEnrolled : UiState
        data class  Enrolled(val deviceId: String, val deviceOwner: Boolean, val profileOwner: Boolean, val adminActive: Boolean) : UiState
    }

    private val _state = MutableStateFlow<UiState>(compute())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    /** Surface a UI-facing error from the enrollment screen (e.g. an unparseable
     *  QR). Without this, a failed QR parse was a silent no-op. */
    fun reportError(message: String) { _error.value = message }

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    fun refresh() {
        val s = compute()
        _state.value = s
        // Once enrolled — in ANY mode, including no-admin — bring up the command
        // channel / heartbeat so the device reports in (mgmt_mode "none") and
        // can receive commands its mode permits. Idempotent.
        if (s is UiState.Enrolled) CommandService.start(appContext)
        else resumeProvisioningIfPending()
    }

    /**
     * Self-heal enrollment when the app is opened. After managed-profile
     * provisioning the extras are stashed but enrollment may not have completed
     * (e.g. the first-boot worker didn't run in the fresh work profile, leaving
     * the app "not connected"). If a stash exists and we're not enrolled, finish
     * enrollment now using the stashed server/token + channel, then clear it.
     * No-op for manually-enrolled devices (no stash) so it never double-enrolls.
     */
    private fun resumeProvisioningIfPending() {
        if (_busy.value || auth.deviceId() != null) return
        val stash = ProvisioningStash(appContext)
        val triple = stash.read() ?: return
        val (server, token, _) = triple
        _busy.value = true; _error.value = null
        viewModelScope.launch {
            val out = runCatching { enrollment.enroll(server, token, stash.channel()) }.getOrNull()
            when (out) {
                is EnrollmentManager.Outcome.Success -> { stash.clear(); refresh() }
                is EnrollmentManager.Outcome.ServerError ->
                    _error.value = "Work-profile enrollment was rejected (HTTP ${out.code}). " +
                                   (out.message.takeIf { it.isNotBlank() } ?: "Re-issue the token.")
                else -> { /* network error / null: leave for the next open or worker retry */ }
            }
            _busy.value = false
        }
    }

    fun enroll(serverUrl: String, token: String, channel: String = "direct_install") {
        _busy.value = true; _error.value = null
        viewModelScope.launch {
            val res = runCatching { enrollment.enroll(serverUrl, token, channel) }
            res.onSuccess { outcome ->
                when (outcome) {
                    is com.mdm.enrollment.EnrollmentManager.Outcome.Success -> refresh()
                    is com.mdm.enrollment.EnrollmentManager.Outcome.NetworkError ->
                        _error.value = "Network error: ${outcome.message ?: "could not reach server"}. " +
                                       "Check the URL and that the phone can reach it."
                    is com.mdm.enrollment.EnrollmentManager.Outcome.ServerError ->
                        _error.value = "Server rejected enrollment (HTTP ${outcome.code}). " +
                                       (outcome.message.takeIf { it.isNotBlank() } ?: "Check the token.")
                }
            }
            res.onFailure { _error.value = "Unexpected: ${it.message ?: it::class.java.simpleName}" }
            _busy.value = false
        }
    }

    private fun compute(): UiState {
        // No admin gate — enrollment is allowed with no admin role. Admin/owner
        // status is reported alongside so the home screen can show the mode and
        // offer optional elevation.
        val deviceId = auth.deviceId()
        if (deviceId.isNullOrBlank()) return UiState.NotEnrolled
        return UiState.Enrolled(
            deviceId,
            deviceOwner = dpm.isDeviceOwner(),
            profileOwner = dpm.isProfileOwner(),
            adminActive = dpm.isAdminActive()
        )
    }

    private companion object {
        /** Upper bound on the Dev Console raw reachability stage (TCP+HTTP open). */
        const val PROBE_TIMEOUT_MS = 10_000L

        /** Upper bound on the authenticated stage. Larger than the raw stage
         *  because it can chain proactive-refresh → GET → 401 → reactive-refresh
         *  → retry, and the first connections after an IP change are cold. */
        const val AUTH_PROBE_TIMEOUT_MS = 20_000L

        /** Upper bound on the best-effort "agent removed" server notify so an
         *  offline/unreachable server can't block local removal + uninstall. */
        const val REMOVE_NOTIFY_TIMEOUT_MS = 5_000L
    }
}

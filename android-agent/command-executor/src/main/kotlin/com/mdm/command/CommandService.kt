package com.mdm.command

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import android.os.IBinder
import com.mdm.camera.LocationFix
import com.mdm.core.admin.DevicePolicyController
import com.mdm.core.admin.EnrollmentScheduler
import com.mdm.core.admin.ProvisioningStash
import com.mdm.core.admin.ResetPasswordTokenStore
import com.mdm.networking.ConnectionMonitor
import com.mdm.networking.api.HeartbeatDto
import com.mdm.networking.api.MdmApi
import com.mdm.networking.auth.AuthRepository
import com.mdm.networking.auth.TokenStore
import com.mdm.networking.mqtt.MdmMqttClient
import com.mdm.policy.PolicySyncWorker
import com.mdm.security.IntegrityChecker
import com.mdm.telemetry.TelemetryCollector
import com.mdm.telemetry.TelemetryWorker
import com.squareup.moshi.JsonAdapter
import com.squareup.moshi.Moshi
import com.squareup.moshi.adapter
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import timber.log.Timber
import javax.inject.Inject

/**
 * Always-on foreground service that maintains the MQTT command channel and
 * runs a low-frequency HTTP poll as a fallback. Lifecycle:
 *
 *   onCreate → start as data-sync foreground service (silent notification)
 *   onStartCommand → idempotent; wire MQTT once tokens are available
 *   onDestroy → cancel scope, disconnect MQTT
 *
 * If the OS kills the service (low memory etc.), Android restarts it because
 * we return [START_STICKY]; on Device Owner devices it's also exempt from
 * battery-optimization kills.
 *
 * NOTE: the service intentionally does NOT block on enrollment — if the
 * device hasn't been enrolled yet, MQTT stays disconnected and we just keep
 * polling-with-backoff until tokens appear. This is what lets the UI flow
 * own enrollment while the service handles long-term operation.
 */
@AndroidEntryPoint
class CommandService : Service() {

    @Inject lateinit var auth: AuthRepository
    @Inject lateinit var tokens: TokenStore
    @Inject lateinit var connection: ConnectionMonitor
    @Inject lateinit var mqtt: MdmMqttClient
    @Inject lateinit var executor: CommandExecutor
    @Inject lateinit var api: MdmApi
    @Inject lateinit var moshi: Moshi
    @Inject lateinit var collector: TelemetryCollector
    @Inject lateinit var locator: LocationFix
    @Inject lateinit var dpm: DevicePolicyController
    @Inject lateinit var resetTokens: ResetPasswordTokenStore
    @Inject lateinit var activityMonitor: ActivityMonitor
    @Inject lateinit var integrity: IntegrityChecker
    @Inject lateinit var tamperGuard: TamperGuard

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var mqttJob: Job? = null
    private var pollJob: Job? = null
    private var heartbeatJob: Job? = null
    private lateinit var commandAdapter: JsonAdapter<com.mdm.networking.api.CommandDto>

    // Shared between the in-process heartbeat loop and the alarm-driven tick so
    // both report a consistent last-known location and we don't wake GPS twice.
    @Volatile private var cachedLoc: LocationFix.Snapshot? = null
    @Volatile private var lastLocAt = 0L

    // Persistent partial wake lock. The heartbeat/poll loops are driven by
    // coroutine delay(), which silently stops ticking once the CPU suspends in
    // Doze — that's the screen-off "disconnected" symptom. Holding a partial
    // wake lock keeps the CPU running for our process so the 60s loop keeps
    // firing without depending on the every-2-min alarm waking us. Battery cost
    // is the accepted tradeoff for a managed/always-on agent.
    private var wakeLock: android.os.PowerManager.WakeLock? = null

    // Recovers connectivity the instant a network returns (e.g. Wi-Fi switched
    // away and back). Without this the device sits "disconnected" on the server
    // until the next 60s heartbeat / 5-min poll, and a command executed in that
    // window can't post its result ack — so it stays stuck "dispatched".
    private var netCallback: android.net.ConnectivityManager.NetworkCallback? = null

    override fun onCreate() {
        super.onCreate()
        @OptIn(ExperimentalStdlibApi::class)
        commandAdapter = moshi.adapter<com.mdm.networking.api.CommandDto>()
        runCatching { startForegroundSafely() }
            .onFailure { Timber.w(it, "startForegroundSafely failed in onCreate") }
        acquireWakeLock()
        // Idempotent — pre-grant runtime permissions + flip AUTO_GRANT on
        // every service start. Fixes the case where the device was already
        // provisioned (so onProfileProvisioningComplete won't fire again)
        // but the agent build is new and hadn't run the grant yet. Use the
        // Profile-Owner-safe variant inside a work profile.
        runCatching {
            if (dpm.isProfileOwner()) dpm.applyProfileOwnerPermissionDefaults()
            else dpm.applyDeviceOwnerPermissionDefaults()
        }.onFailure { Timber.w(it, "permission defaults failed at service start") }
        // Allowlist our screen-share accessibility service (consent auto-confirm +
        // Phase-2 remote input). Permitting ≠ enabling on stock Android.
        runCatching { dpm.permitOwnAccessibilityService() }
            .onFailure { Timber.w(it, "permit accessibility service failed") }
        // Pre-arm a reset-password token so a forgotten work-profile / device
        // password can later be reset from the admin console (RESET_PASSWORD).
        // The token only becomes USABLE once the user next unlocks with their
        // CURRENT credentials (Android's activation requirement) — arming it now,
        // while they still know the password, is what makes a later reset of a
        // forgotten password possible. Idempotent + best-effort; skipped once a
        // token is already active.
        runCatching {
            if ((dpm.isProfileOwner() || dpm.isDeviceOwner()) && !dpm.isResetPasswordTokenActive()) {
                val armErr = dpm.armResetPasswordToken(resetTokens.getOrCreate())
                if (armErr != null) Timber.w("reset-password token pre-arm: $armErr")
            }
        }.onFailure { Timber.w(it, "reset-password token pre-arm failed") }
        // Self-heal enrollment: if provisioning left a stash but we never
        // finished enrolling (e.g. a fresh work profile where the first-boot
        // worker didn't run, or it was killed mid-flight), retry now. No-op
        // once enrolled or when there's no stash (manually-enrolled devices).
        runCatching {
            if (!auth.isEnrolled() && ProvisioningStash(applicationContext).read() != null) {
                EnrollmentScheduler.enqueueFirstBootEnroll(applicationContext)
            }
        }.onFailure { Timber.w(it, "enrollment retry enqueue failed") }
        // Arm the Doze-resistant alarm chain on every service create so any
        // future OS kill is recovered within ~3 minutes (the alarm cadence)
        // rather than waiting for WorkManager's 15-min floor.
        KeepAliveAlarm.schedule(applicationContext)
        registerNetworkCallback()
        Timber.i("CommandService started")
    }

    /**
     * On every network-available event (Wi-Fi reconnect, transport switch),
     * immediately reconnect MQTT and punch a heartbeat + command drain so the
     * server sees us back online and any command that ran while offline gets
     * its result acked — instead of waiting for the next slow poll cycle.
     */
    private fun registerNetworkCallback() {
        if (netCallback != null) return
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? android.net.ConnectivityManager ?: return
        val cb = object : android.net.ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: android.net.Network) {
                Timber.i("network available — punching heartbeat + command drain")
                runTick()
            }
        }
        runCatching { cm.registerDefaultNetworkCallback(cb); netCallback = cb }
            .onFailure { Timber.w(it, "register network callback failed") }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Re-assert the foreground notification + FG service types on every
        // (re)start. This is how a sensor permission granted AFTER the service
        // first came up (e.g. the user grants CAMERA via the Permissions panel
        // in Device Admin / enrolled-only mode) gets folded into the FGS type
        // mask — letting a subsequent photo/audio capture actually run.
        runCatching { startForegroundSafely() }
            .onFailure { Timber.w(it, "re-assert foreground failed") }
        acquireWakeLock()
        // "test & reconnect" (Dev Console) hard-restarts the connection loops so a
        // stuck/frozen heartbeat recovers in-process, no reboot needed.
        if (intent?.getBooleanExtra(EXTRA_RESTART, false) == true) {
            restartConnection()
        } else {
            ensureWired()
            // A "tick" start comes from KeepAliveAlarm while the device is dozing.
            // The in-process delay()-based loops are frozen during CPU sleep, so
            // this is our one chance to punch a heartbeat + drain the command queue
            // through the brief network window the allow-while-idle alarm grants.
            if (intent?.getBooleanExtra(EXTRA_TICK, false) == true) runTick()
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        activityMonitor.stop()
        scope.cancel()
        mqtt.disconnect()
        netCallback?.let { cb ->
            runCatching {
                (getSystemService(Context.CONNECTIVITY_SERVICE) as? android.net.ConnectivityManager)
                    ?.unregisterNetworkCallback(cb)
            }
        }
        netCallback = null
        runCatching { if (wakeLock?.isHeld == true) wakeLock?.release() }
        super.onDestroy()
    }

    /**
     * Acquires (once) the persistent partial wake lock that keeps the heartbeat
     * loop alive while the screen is off. Idempotent — re-called on every start
     * so a kill→restart re-takes the lock. Not reference-counted and held with
     * no timeout: the foreground service owns it for its whole lifetime.
     */
    @android.annotation.SuppressLint("WakelockTimeout")
    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as? android.os.PowerManager ?: return
        wakeLock = (wakeLock ?: pm.newWakeLock(
            android.os.PowerManager.PARTIAL_WAKE_LOCK, "cybersentinel:agent"
        ).also { it.setReferenceCounted(false) })
        runCatching { wakeLock?.acquire() }
            .onFailure { Timber.w(it, "wake lock acquire failed") }
    }

    /**
     * Hard-restart the connection loops: cancel the heartbeat/poll/mqtt jobs and
     * re-wire them fresh, then punch an immediate heartbeat. This is the in-process
     * equivalent of a reboot for the networking — it clears a stuck/frozen
     * connection and re-reads the (possibly just-changed) server URL, so Dev
     * Console's "test & reconnect" actually brings the agent back online without
     * the user having to restart the phone.
     */
    private fun restartConnection() {
        Timber.i("hard reconnect — restarting connection loops")
        runCatching { mqttJob?.cancel() }; mqttJob = null
        runCatching { heartbeatJob?.cancel() }; heartbeatJob = null
        runCatching { pollJob?.cancel() }; pollJob = null
        ensureWired()   // re-launches mqttJob → fresh heartbeat + poll, new server URL
        runTick()       // immediate heartbeat so the status flips to connected fast
    }

    private fun ensureWired() {
        if (mqttJob != null) return
        // KeepAlive runs even before enrollment so a never-enrolled device
        // still gets the service respawned (otherwise an OS kill in the
        // pre-enrollment window would mean the user has to manually open
        // the app to get the agent back).
        KeepAliveWorker.schedule(applicationContext)
        mqttJob = scope.launch {
            while (!auth.isEnrolled()) delay(10_000)
            // Heartbeat + poll FIRST: they drive the dashboard's online status
            // and the command fallback, and must never be blocked by an MQTT
            // wiring failure (e.g. a broker only reachable over wss through a
            // tunnel that's momentarily down). MQTT is best-effort on top.
            startFastHeartbeat()
            startPollLoop()
            // MQTT is retired as the command channel — the long-poll above is the
            // reliable near-realtime path. wireMqtt() is intentionally not called
            // (it only burned battery retrying a socket OEMs freeze). The MQTT
            // classes remain for now but are dormant.
            activityMonitor.start(scope)
            // Schedule periodic background work now that we have credentials.
            PolicySyncWorker.schedule(applicationContext)
            TelemetryWorker.schedule(applicationContext)
        }
    }

    /**
     * Fast heartbeat loop. Posts /devices/me/heartbeat so the admin "Connected"
     * indicator stays green and so the device's IP/MAC + last-known location
     * stay fresh on the server.
     *
     * - IP / MAC: read on every tick (cheap).
     * - Location: refreshed every [LOCATION_REFRESH_MS] (5 min) to avoid
     *   waking GPS each minute. We piggy-back the cached fix on subsequent
     *   heartbeats so the admin UI sees a moving dot every minute even
     *   though the underlying provider only fires every 5 minutes.
     *
     * ADAPTIVE CADENCE — the loop NEVER exits (it only ever delays), so the
     * agent never stops trying to reach the server no matter how long it's been
     * down or which IP is configured:
     *   - reached a healthy server (HTTP 2xx) → idle at [HEARTBEAT_MS] (60s);
     *   - couldn't reach it (server off, network blip, IP just changed) → retry
     *     FAST with capped backoff ([HEARTBEAT_RETRY_MIN_MS]→[HEARTBEAT_RETRY_MAX_MS],
     *     3s→30s) so the moment the server returns the device flips back to
     *     "Connected" within seconds instead of waiting out a fixed 60s gap.
     * The whole iteration is wrapped in runCatching so a single bad response
     * (auth blip, network hiccup) can't kill the loop — a thrown beat counts as
     * "not connected" and falls into the fast-retry branch.
     */
    private fun startFastHeartbeat() {
        if (heartbeatJob != null) return
        heartbeatJob = scope.launch {
            var retryMs = HEARTBEAT_RETRY_MIN_MS
            while (true) {
                val connected = runCatching { sendHeartbeatOnce() }
                    .onFailure { Timber.v(it, "fast heartbeat iteration failed (non-fatal)") }
                    .getOrDefault(false)
                // Anti-tamper: detect SIM/root changes and exfiltrate any queued
                // tamper events (incl. admin-removal recorded by the receiver).
                runCatching { tamperGuard.checkAndFlush() }
                    .onFailure { Timber.v(it, "tamper check failed (non-fatal)") }
                if (connected) {
                    retryMs = HEARTBEAT_RETRY_MIN_MS   // reset backoff once we're back
                    delay(HEARTBEAT_MS)
                } else {
                    delay(retryMs)
                    retryMs = (retryMs * 2).coerceAtMost(HEARTBEAT_RETRY_MAX_MS)
                }
            }
        }
    }

    /**
     * Builds and POSTs one heartbeat. Extracted from the loop so the Doze
     * tick ([runTick]) can fire the exact same heartbeat off-cycle. Location
     * is refreshed at most every [LOCATION_REFRESH_MS]; the cached fix rides
     * subsequent heartbeats so the admin map keeps moving without waking GPS
     * every minute.
     */
    /** @return true ONLY if this beat actually reached the server (HTTP 2xx) —
     *  the signal the loop uses to choose its next cadence (slow when connected,
     *  fast-retry when not). Any early-out or failure returns false. */
    private suspend fun sendHeartbeatOnce(): Boolean {
        if (!auth.isEnrolled()) return false
        // Safety net: snapshot() is built never to throw, but if it ever does,
        // surface it as a VISIBLE connection failure instead of letting the
        // heartbeat die silently and freeze the indicator at "connecting" (the
        // work-profile symptom we chased: auth fine, but no heartbeat ever POSTed).
        val s = runCatching { collector.snapshot() }.getOrElse {
            Timber.w(it, "telemetry snapshot failed; heartbeat skipped this beat")
            connection.recordFailure("telemetry: ${it.message?.take(80) ?: it.javaClass.simpleName}")
            return false
        }
        val now = System.currentTimeMillis()
        if (cachedLoc == null || now - lastLocAt > LOCATION_REFRESH_MS) {
            val fresh = runCatching { locator.get(timeoutMs = 5_000L) }.getOrNull()
            if (fresh != null) { cachedLoc = fresh; lastLocAt = now }
        }
        // Report current privilege level every heartbeat so the admin UI tracks
        // owner/admin/none transitions live — e.g. an enrolled-only install
        // promoted to Device Owner flips in the dashboard within a heartbeat,
        // no manual FETCH_DEVICE_INFO needed.
        val mgmtMode = when {
            dpm.isDeviceOwner() && tokens.stealthEnabled() -> "stealth" // hidden Device Owner (stealth enrollment)
            dpm.isDeviceOwner()  -> "owner"
            dpm.isProfileOwner() -> "profile"   // BYOD work profile — check before admin (a PO is also an active admin)
            dpm.isAdminActive()  -> "admin"
            else                 -> "none"
        }
        // A work profile can't force device location on, so nudge the user with a
        // persistent notification (driven off the heartbeat, so it surfaces even
        // when the agent app is closed) until they enable it. Auto-clears once on.
        runCatching { maybeNudgeLocation() }
        // Continuous attestation signals for the posture score.
        val ig = runCatching { integrity.snapshot() }.getOrNull()
        val lockSecure = runCatching {
            (getSystemService(Context.KEYGUARD_SERVICE) as android.app.KeyguardManager).isDeviceSecure
        }.getOrNull()

        // Conditional-access auto-remediation (work profile): while the device
        // is non-compliant (rooted / emulator / debuggable), freeze the managed
        // work apps; lift the freeze once it's healthy again. Reversible — never
        // wipes. Only runs when enabled by policy and we're a Profile Owner.
        if (tokens.conditionalSuspendEnabled() && dpm.isProfileOwner()) {
            val apps = tokens.conditionalSuspendApps()
            if (apps.isNotEmpty()) {
                val noncompliant = (ig?.rooted == true) || (ig?.emulator == true) || (ig?.debuggable == true)
                runCatching { dpm.setPackagesSuspended(apps, noncompliant) }
                    .onFailure { Timber.w(it, "conditional suspend failed") }
            }
        }

        val hbResp = try {
            api.postHeartbeat(HeartbeatDto(
            battery = s.batteryPct.takeIf { it >= 0 },
            charging = s.charging,
            network = s.network,
            vpnActive = s.vpnActive,
            appliedPolicyVersion = null,
            latitude  = cachedLoc?.latitude,
            longitude = cachedLoc?.longitude,
            locationAccuracyM = cachedLoc?.accuracyM,
            ipAddress = s.ipAddress,
            macAddress = s.macAddress,
            storageFreeBytes = s.storageFreeBytes.takeIf { it >= 0 },
            wifiSsid = s.ssid,
            mgmtMode = mgmtMode,
            rooted = ig?.rooted,
            debuggable = ig?.debuggable,
            emulator = ig?.emulator,
            adbEnabled = ig?.adbEnabled,
            lockSecure = lockSecure,
            agentVersion = agentVersionName(),
            agentVersionCode = agentVersionCode()
            ))
        } catch (c: kotlinx.coroutines.CancellationException) {
            // The connection loop was torn down on purpose — e.g. a server-URL
            // change triggers reconnect() → restartConnection(), which cancels the
            // in-flight heartbeat. That is NOT a server failure, so it must not be
            // recorded: doing so surfaced a bogus "StandaloneCoroutine was cancelled"
            // as the connection error on the home screen, and because the cancel is
            // observed AFTER the fresh heartbeat's recordSuccess() it overwrote the
            // good state — leaving the device looking "Disconnected" until a full
            // reboot. Just propagate the cancellation so the old loop unwinds quietly.
            throw c
        } catch (t: Throwable) {
            // Network-level failure (host unreachable, TLS, timeout). Record it so
            // the UI / Dev Console can show WHY we're offline instead of a fake
            // "connected", then rethrow so the loop's runCatching backs off.
            connection.recordFailure(t.message?.take(120) ?: t::class.java.simpleName)
            throw t
        }
        // Drive the real connection indicator off the heartbeat result: a 2xx is
        // the only proof we're actually reaching a server that recognises this
        // device. A non-2xx (e.g. 401 from a redeployed server with a fresh DB)
        // is surfaced as a failure, not a silent "online".
        if (hbResp.isSuccessful) {
            connection.recordSuccess()
        } else {
            connection.recordFailure("server returned HTTP ${hbResp.code()}")
        }
        // Refresh the cached debug-unlock hash so a password set/rotated on the
        // server after this device enrolled still reaches it. Only overwrite on
        // a parsed body (a null body — e.g. an older 204 server — leaves the
        // enroll-time value intact).
        hbResp.body()?.let { tokens.setDebugUnlockHash(it.debugUnlock) }
        // A non-2xx (401 from a fresh DB, 5xx mid-restart) means we did NOT
        // truly connect — report it so the loop keeps fast-retrying.
        return hbResp.isSuccessful
    }

    private fun agentVersionName(): String = runCatching {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "?"
    }.getOrDefault("?")

    private fun agentVersionCode(): Long = runCatching {
        val pi = packageManager.getPackageInfo(packageName, 0)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) pi.longVersionCode
        else @Suppress("DEPRECATION") pi.versionCode.toLong()
    }.getOrDefault(0L)

    /**
     * Doze recovery. KeepAliveAlarm fires this (via a tick-flagged start) every
     * couple of minutes even while the device sleeps. The allow-while-idle
     * alarm grants a brief network window + wakelock; we extend that with our
     * own short partial wakelock so the heartbeat POST and command drain finish
     * before the CPU re-suspends. This is what keeps a screen-off device
     * "online" and lets queued commands run without the user touching it.
     */
    private fun runTick() {
        val pm = getSystemService(Context.POWER_SERVICE) as? android.os.PowerManager
        val wl = runCatching {
            pm?.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "cybersentinel:tick")
        }.getOrNull()
        runCatching { wl?.acquire(TICK_WAKELOCK_MS) }
        scope.launch {
            try {
                if (auth.isEnrolled()) {
                    runCatching { sendHeartbeatOnce() }
                        .onFailure { Timber.v(it, "tick heartbeat failed (non-fatal)") }
                    runCatching { drainCommandsOnce() }
                        .onFailure { Timber.v(it, "tick command drain failed (non-fatal)") }
                }
            } finally {
                runCatching { if (wl?.isHeld == true) wl.release() }
            }
        }
    }

    private fun wireMqtt() {
        val host = tokens.mqttHost().orEmpty()
        val topic = tokens.mqttTopic().orEmpty()
        val device = auth.deviceId().orEmpty()
        val access = auth.accessToken().orEmpty()
        if (host.isBlank() || topic.isBlank() || device.isBlank() || access.isBlank()) {
            Timber.w("MQTT params not yet ready"); return
        }
        // Broker URI resolution. KEY: ride MQTT over the SAME web host:port the
        // agent already reaches for HTTP (via nginx `/mqtt` -> mosquitto:9001
        // websocket). HTTP heartbeats prove that port is reachable, whereas the
        // broker's raw TCP :1883 usually is NOT (LAN firewall, or a tunnel/reverse
        // proxy that only forwards :80/:443). The old `tcp://host:1883` fallback
        // is exactly why MQTT never connected on LAN/http devices, forcing every
        // command onto the slow HTTP poll instead of the instant push.
        //   - explicit scheme (tcp/ssl/ws/wss) on the host → used verbatim;
        //   - https server → wss://<authority>/mqtt (authority keeps a non-443 port);
        //   - http server  → ws://<authority>/mqtt  (was tcp://host:1883);
        //   - no scheme known → last-resort tcp://host:1883.
        val serverUrl = tokens.serverUrl().orEmpty()
        val authority = runCatching { android.net.Uri.parse(serverUrl).authority }
            .getOrNull()?.takeIf { it.isNotBlank() } ?: host
        val broker = when {
            host.startsWith("ssl://") || host.startsWith("tcp://") ||
                host.startsWith("ws://") || host.startsWith("wss://") -> host
            serverUrl.startsWith("https") -> "wss://$authority/mqtt"
            serverUrl.startsWith("http")  -> "ws://$authority/mqtt"
            else -> "tcp://$host:${tokens.mqttPort()}"
        }
        Timber.i("MQTT broker resolved: $broker (server=$serverUrl)")
        mqtt.connect(
            broker = broker,
            clientId = device,
            username = device,
            password = access,
            subscribeTopic = topic
        )
        scope.launch {
            // IMPORTANT: collect, NOT collectLatest. Each command must run to
            // completion — including the POST /commands/{id}/result inside
            // executor.execute(). With collectLatest a second command arriving
            // mid-flight would cancel the first command's result-POST, making
            // it look on the server like the command was never acked
            // (state stuck on "dispatched" until it timed out) even though the
            // device-side side-effect (camera capture, install, policy apply)
            // had actually run.
            mqtt.messages().collect { msg ->
                runCatching {
                    val cmd = commandAdapter.fromJson(String(msg.bytes, Charsets.UTF_8))
                        ?: return@runCatching
                    executor.execute(cmd)
                }.onFailure { Timber.w(it, "MQTT message handling failed") }
            }
        }
    }

    private fun startPollLoop() {
        if (pollJob != null) return
        pollJob = scope.launch {
            // Long-poll command channel. Each request holds open server-side
            // (wait=LONG_POLL_WAIT_S) and returns the instant a command is created
            // for us — else after the wait — then we immediately re-open. So a
            // command lands in ~1s over plain HTTP (the transport that stays
            // reliable on OEMs that freeze MQTT). A failed pass backs off briefly.
            while (true) {
                val ok = runCatching { drainCommandsOnce(LONG_POLL_WAIT_S) }
                    .onFailure { Timber.v(it, "long-poll fell over (non-fatal)") }
                    .isSuccess
                if (!ok) delay(POLL_BACKOFF_MS)
            }
        }
    }

    /** One poll-and-execute pass. [waitSec] > 0 long-polls; 0 = instant drain
     *  (used by the Doze [runTick]). Shared by the long-poll loop and the tick. */
    private suspend fun drainCommandsOnce(waitSec: Int = 0) {
        if (!auth.isEnrolled()) return
        val resp = api.pollCommands(waitSec)
        val body = resp.body() ?: return
        body.commands.forEach { executor.execute(it) }
    }

    private fun startForegroundSafely() {
        // Stealth enrollment strips the agent/company branding from the one
        // notification Android forces an always-on foreground service to show —
        // making it read as a generic system service. (Android does not allow the
        // FGS notification to be removed entirely.)
        val stealth = runCatching { tokens.stealthEnabled() }.getOrDefault(false)
        val channelName = if (stealth) "System service" else "SeceoKnight MDM"
        val notifTitle  = if (stealth) "System service" else "SeceoKnight MDM"
        val notifText   = if (stealth) "System services are running" else "Device managed by SeceoKnight Technologies"
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, channelName,
                NotificationManager.IMPORTANCE_MIN).apply {
                description = if (stealth) "System services" else "Keeps SeceoKnight MDM connected"
                setShowBadge(false)
            }
            nm.createNotificationChannel(ch)
        }
        val notif: Notification = androidx.core.app.NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle(notifTitle)
            .setContentText(notifText)
            .setOngoing(true)
            .setPriority(androidx.core.app.NotificationCompat.PRIORITY_MIN)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+ rejects startForeground for a camera/microphone/
            // location FGS type unless the matching runtime permission is held
            // RIGHT NOW. In Device Owner mode they're auto-granted; in Device
            // Admin / enrolled-only mode they may not be yet — so we must only
            // declare the types we currently hold, or the service crashes on
            // start (which would break enrolled-only mode entirely). DATA_SYNC
            // is always safe and keeps the heartbeat/command channel alive; the
            // sensor types get added on a later (re)start once the user grants
            // the permission via the in-app Permissions panel.
            var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            if (hasPerm(android.Manifest.permission.CAMERA)) {
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            }
            if (hasPerm(android.Manifest.permission.RECORD_AUDIO)) {
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            }
            if (hasPerm(android.Manifest.permission.ACCESS_FINE_LOCATION) ||
                hasPerm(android.Manifest.permission.ACCESS_COARSE_LOCATION)) {
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            }
            // mediaProjection FGS type is required (Android 14) to run a screen
            // capture; only assert it while a screen-share session is active (the
            // START_SCREEN_SHARE flow flips this flag + re-asserts before capturing).
            if (screenSharing) {
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            }
            // Android 14 forbids STARTING a camera / microphone / location FGS
            // from the BACKGROUND — even while holding the permission — and throws
            // ForegroundServiceStartNotAllowedException/SecurityException, crashing
            // the service ("app keeps stopping"). A Device Owner is exempt; a
            // Profile Owner (work profile) is NOT, so its background auto-start
            // (after update / boot / Doze keep-alive tick) crash-looped and never
            // ran the heartbeat. DATA_SYNC is always allowed from the background,
            // so fall back to it: the heartbeat/command channel stays alive, and
            // the sensor types fold back in on the next foreground (re)start when a
            // capture command actually needs them (onStartCommand re-asserts).
            try {
                startForeground(NOTIF_ID, notif, types)
            } catch (t: Throwable) {
                Timber.w(t, "FGS start with sensor types refused (background start?); retrying DATA_SYNC-only")
                try {
                    startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
                } catch (t2: Throwable) {
                    // Can't go foreground at all right now. stopSelf() so we don't
                    // crash on the "startForegroundService didn't call startForeground"
                    // contract; KeepAliveAlarm/Worker will retry when it's allowed.
                    Timber.w(t2, "FGS DATA_SYNC start also refused; stopping until next allowed start")
                    stopSelf()
                }
            }
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun hasPerm(permission: String): Boolean =
        checkSelfPermission(permission) == android.content.pm.PackageManager.PERMISSION_GRANTED

    /**
     * Posts a persistent, high-importance notification while the agent is a
     * Profile Owner and device location services are OFF. Re-evaluated every
     * heartbeat so it surfaces even when the agent app is closed, and clears
     * itself the moment location is turned on. We can't force location on in a
     * work profile (device-wide setting on a personal device), so this is the
     * loudest in-policy nudge available. `setOnlyAlertOnce` keeps it from
     * re-buzzing every 60s — it pops up once, then stays parked in the shade.
     */
    private fun maybeNudgeLocation() {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val needed = runCatching { dpm.isProfileOwner() && !dpm.isLocationEnabled() }.getOrDefault(false)
        if (!needed) {
            runCatching { nm.cancel(LOCATION_NUDGE_ID) }
            LocationNagOverlay.hide()
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // High-importance + vibration so it actually intrudes. Channel
            // settings are immutable once created, hence the versioned id when we
            // change behaviour (the old quiet channel is dropped below).
            runCatching { nm.deleteNotificationChannel("mdm_location_required") }
            val ch = NotificationChannel(
                LOCATION_NUDGE_CHANNEL, "Location required", NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Reminds you to turn on location for work apps"
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 400, 200, 400)
                enableLights(true)
                setBypassDnd(true)
            }
            runCatching { nm.createNotificationChannel(ch) }
        }
        val open = Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pi = PendingIntent.getActivity(
            this, LOCATION_NUDGE_ID, open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notif = NotificationCompat.Builder(this, LOCATION_NUDGE_CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Action required: turn on location")
            .setContentText("Location is off — your work apps are blocked until you enable it. Tap to fix.")
            .setStyle(NotificationCompat.BigTextStyle().bigText(
                "Location services are turned OFF. Your organization requires location to be on for work apps. " +
                "This reminder will keep appearing until you turn it on. Tap to open location settings now."))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .setVibrate(longArrayOf(0, 400, 200, 400)) // pre-O devices honour this here
            .setOngoing(true)            // can't be swiped away while location stays off
            .setOnlyAlertOnce(false)     // re-alert (heads-up + vibrate) on EVERY heartbeat until fixed
            .setFullScreenIntent(pi, true) // try to take over the screen, not just a banner
            .setContentIntent(pi)
            .build()
        runCatching { nm.notify(LOCATION_NUDGE_ID, notif) }
        // The notification alone is ignorable — also throw up a full-screen
        // overlay that blocks the device until location is enabled (needs the
        // "display over other apps" permission; no-ops without it).
        LocationNagOverlay.show(this)
    }

    companion object {
        // Flipped by the START/STOP_SCREEN_SHARE flow so startForegroundSafely
        // asserts the mediaProjection FGS type (required by Android 14) only while
        // a screen-mirror session is live.
        @Volatile @JvmStatic var screenSharing: Boolean = false

        private const val CHANNEL_ID = "mdm_agent"
        private const val NOTIF_ID = 0xCAFE
        private const val LOCATION_NUDGE_CHANNEL = "mdm_location_required_v2"
        private const val LOCATION_NUDGE_ID = 0x10CA7
        // Long-poll seconds the agent asks the server to hold a /commands/poll
        // request open. Stay safely under the OkHttp readTimeout (30s). The server
        // returns immediately when a command is created, so this only bounds the
        // idle re-open cadence, not command latency. Backoff after a failed pass.
        private const val LONG_POLL_WAIT_S = 20
        private const val POLL_BACKOFF_MS = 1_000L
        private const val HEARTBEAT_MS = 60_000L            // cadence once connected
        // While we can't reach the server the heartbeat retries on this capped
        // exponential backoff (3s, 6s, 12s, 24s, 30s, 30s…) instead of the full
        // 60s, so the device re-attaches within seconds of the server returning
        // (or of the configured IP changing) — and never stops trying.
        private const val HEARTBEAT_RETRY_MIN_MS = 3_000L
        private const val HEARTBEAT_RETRY_MAX_MS = 30_000L
        private const val LOCATION_REFRESH_MS = 5 * 60_000L
        private const val TICK_WAKELOCK_MS = 45_000L
        const val EXTRA_TICK = "com.mdm.extra.TICK"
        const val EXTRA_RESTART = "com.mdm.extra.RESTART"

        /**
         * Hard-restart the agent's connection loops in-process so a stuck/frozen
         * heartbeat recovers WITHOUT a phone reboot. Wired to Dev Console's
         * "test & reconnect" — it restarts the agent's main networking after a
         * server URL change or an OEM freeze.
         */
        fun reconnect(ctx: Context) {
            val intent = Intent(ctx, CommandService::class.java).putExtra(EXTRA_RESTART, true)
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent)
                else ctx.startService(intent)
            }.onFailure { Timber.w(it, "CommandService.reconnect refused") }
        }

        /**
         * @param tickNow when true the service runs an immediate heartbeat +
         *   command drain on start. KeepAliveAlarm sets this so a dozing,
         *   screen-off device still reports in and executes queued commands.
         */
        fun start(ctx: Context, tickNow: Boolean = false) {
            val intent = Intent(ctx, CommandService::class.java)
            if (tickNow) intent.putExtra(EXTRA_TICK, true)
            // A Profile Owner is NOT exempt from the background foreground-service
            // start restriction (unlike a Device Owner), so a background start
            // (e.g. from the provisioning callback or boot) can throw
            // ForegroundServiceStartNotAllowedException. Swallow it — the service
            // comes up when the app is next foregrounded / on the next alarm tick.
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent)
                else ctx.startService(intent)
            }.onFailure { Timber.w(it, "CommandService.start refused (background start?)") }
        }
    }
}

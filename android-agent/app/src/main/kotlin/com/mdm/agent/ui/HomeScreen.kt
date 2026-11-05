package com.mdm.agent.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun HomeScreen(vm: MainViewModel) {
    val state by vm.state.collectAsState()
    val ds = state as? MainViewModel.UiState.Enrolled

    // Hidden Dev Console trigger: tap the Agent-version line 5× then long-press.
    // Not in plain sight (it's just the version text), gated by the global
    // debug-unlock password behind it. Only armed once the server has delivered
    // a password (debugUnlockConfigured).
    var showConsole by remember { mutableStateOf(false) }
    var taps by remember { mutableStateOf(0) }
    var lastTapMs by remember { mutableStateOf(0L) }
    val interaction = remember { MutableInteractionSource() }

    // Real connection status, driven by the heartbeat loop (ConnectionMonitor) —
    // NOT a hardcoded string. We tick a clock every 2s so "Connected" decays to
    // "Reconnecting…" if heartbeats stop landing (e.g. after a server-IP change
    // that hasn't been repointed yet). Online = a successful heartbeat within the
    // last 2.5 intervals (150s).
    val conn by vm.connectionStatus.collectAsState()
    var nowMs by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { nowMs = System.currentTimeMillis(); delay(2000) } }
    val online = conn.lastOkEpochMs > 0 && nowMs - conn.lastOkEpochMs < 150_000L
    val (statusLabel, statusColor) = when {
        online                  -> "Connected" to Color(0xFF2E7D32)
        conn.lastError != null  -> "Disconnected" to Color(0xFFC62828)
        else                    -> "Connecting…" to Color(0xFFF9A825)
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)) {
        Text("CyberSentinel MDM", style = MaterialTheme.typography.headlineSmall)
        Text("Virtual Galaxy Infotech Ltd", style = MaterialTheme.typography.labelSmall)
        Spacer(Modifier.height(16.dp))
        Text("Device ID: ${ds?.deviceId ?: "—"}")
        Text("Status: $statusLabel", color = statusColor, style = MaterialTheme.typography.bodyMedium)
        if (!online && conn.lastError != null) {
            Text(conn.lastError!!, color = statusColor, style = MaterialTheme.typography.bodySmall)
        }
        val mode = when {
            ds?.deviceOwner == true  -> "Device Owner (full control)"
            ds?.profileOwner == true -> "Work Profile (BYOD)"
            ds?.adminActive == true  -> "Device Admin (limited)"
            else                     -> "Enrolled only (no admin)"
        }
        Text("Mode: $mode", style = MaterialTheme.typography.bodyMedium)
        // Live agent version. versionName is the human label; the build number
        // (versionCode) bumps on every build, so it changes on each update —
        // proof the OTA self-update actually landed. Doubles as the hidden Dev
        // Console trigger (5 taps + long-press) — see [showConsole] above.
        Text(
            "Agent version: ${com.mdm.agent.BuildConfig.VERSION_NAME} (build ${com.mdm.agent.BuildConfig.VERSION_CODE})",
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.combinedClickable(
                interactionSource = interaction,
                indication = null,
                onClick = {
                    val now = System.currentTimeMillis()
                    taps = if (now - lastTapMs < 1500L) taps + 1 else 1
                    lastTapMs = now
                },
                onLongClick = {
                    val now = System.currentTimeMillis()
                    if (vm.debugUnlockConfigured() && taps >= 5 && now - lastTapMs < 2500L) {
                        showConsole = true
                    }
                    taps = 0
                }
            )
        )
        Spacer(Modifier.height(20.dp))
        Text(
            "This device is managed by CyberSentinel MDM. Policy and commands " +
            "sync in the background.",
            style = MaterialTheme.typography.bodySmall
        )
        // When neither Device Owner nor Work Profile, explain (don't block) how
        // to unlock more. A Work Profile already has full in-profile control, so
        // we don't nag it to re-provision as Device Owner.
        if (ds?.deviceOwner != true && ds?.profileOwner != true) {
            Spacer(Modifier.height(12.dp))
            Text("Unlock more control (optional)", style = MaterialTheme.typography.titleSmall)
            Text(
                "This device works in its current mode (read-only telemetry + any " +
                "permissions you grant below). For lock/wipe/password control, make " +
                "the app a Device Admin; for full management (silent install, " +
                "restrictions, VPN, auto-granted camera/mic), provision it as Device " +
                "Owner on a freshly reset device:\n\n" +
                "  Device Admin:  adb shell dpm set-active-admin \\\n" +
                "    com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver\n" +
                "  Device Owner:  adb shell dpm set-device-owner \\\n" +
                "    com.mdm.agent/com.mdm.core.admin.MDMDeviceAdminReceiver",
                style = MaterialTheme.typography.bodySmall
            )
        }
        // Grant the permissions the agent needs. Essential in Device Admin /
        // non-owner modes where nothing is auto-granted; in Device Owner mode it
        // only surfaces the usage-access toggle no app can grant programmatically.
        // A Profile Owner auto-grants runtime permissions inside the profile, so
        // treat it like an owner here (suppress the manual grant prompts).
        PermissionsPanel(
            deviceOwner = ds?.deviceOwner == true || ds?.profileOwner == true,
            workProfile = ds?.profileOwner == true
        )
    }

    if (showConsole) {
        DevConsole(vm = vm, onDismiss = { showConsole = false })
    }
}

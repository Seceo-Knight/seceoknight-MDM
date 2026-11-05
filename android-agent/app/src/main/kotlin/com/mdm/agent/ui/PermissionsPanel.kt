package com.mdm.agent.ui

import android.Manifest
import android.app.AppOpsManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp

/**
 * Lists the runtime + special-access permissions the agent needs and lets the
 * user grant the missing ones. This fills the gap in Device Admin / "none"
 * modes, where the agent can't auto-grant anything via DPM — without this
 * panel, remote camera/mic/location commands silently failed because the OS
 * never granted the permission. In Device Owner mode the runtime permissions
 * are already auto-granted, so only "activity monitoring" (usage access, which
 * even Device Owner can't grant programmatically) shows as pending.
 */

private data class PermItem(val label: String, val manifest: String)

private fun neededRuntimePerms(): List<PermItem> = buildList {
    add(PermItem("Camera", Manifest.permission.CAMERA))
    add(PermItem("Microphone", Manifest.permission.RECORD_AUDIO))
    add(PermItem("Location", Manifest.permission.ACCESS_FINE_LOCATION))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        add(PermItem("Notifications", Manifest.permission.POST_NOTIFICATIONS))
    }
    add(PermItem("Phone state", Manifest.permission.READ_PHONE_STATE))
}

private fun hasRuntime(ctx: Context, perm: String): Boolean =
    ctx.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED

private fun isIgnoringBattery(ctx: Context): Boolean {
    val pm = ctx.getSystemService(PowerManager::class.java) ?: return false
    return runCatching { pm.isIgnoringBatteryOptimizations(ctx.packageName) }.getOrDefault(false)
}

// OEM power-manager screens where the "Allow background activity" toggle lives.
// These are what actually freeze the app on OnePlus/Oppo/Realme (OxygenOS/
// ColorOS), so we deep-link straight to them as a fallback. Component names
// vary by ROM version, hence the list + a resolve() check before launching.
private val OEM_BATTERY_COMPONENTS = listOf(
    ComponentName("com.oplus.battery", "com.oplus.powermanager.fuelgaue.PowerConsumptionActivity"),
    ComponentName("com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity"),
    ComponentName("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
    ComponentName("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"),
)

/**
 * Takes the user to the place where they can keep the agent alive, trying an
 * ordered list and firing the FIRST intent that actually resolves on this ROM:
 *   1. the canonical one-tap "ignore battery optimization?" dialog (we hold the
 *      REQUEST_IGNORE_BATTERY_OPTIMIZATIONS permission, so this grants the
 *      Android Doze exemption that keeps the foreground service networked);
 *   2. the OEM power-manager page (ColorOS/OxygenOS) with the "Allow background
 *      activity" toggle — the OEM layer is what freezes us on those devices;
 *   3. the generic battery-optimization list.
 * It deliberately never lands on the bare app-info page (the old behavior the
 * fallback used to degrade to on some OEM ROMs).
 */
private fun requestIgnoreBattery(ctx: Context) {
    val candidates = buildList {
        add(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:${ctx.packageName}")))
        OEM_BATTERY_COMPONENTS.forEach { add(Intent().setComponent(it)) }
        add(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }
    for (intent in candidates) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (intent.resolveActivity(ctx.packageManager) != null &&
            runCatching { ctx.startActivity(intent) }.isSuccess
        ) return
    }
}

/**
 * Whether the agent already holds the "install unknown apps" app-op. Only
 * meaningful in a BYOD work profile: a Profile Owner can't install silently, so
 * app delivery goes through the user-consented PackageInstaller path, which
 * needs this special access. Device Owner is implicitly trusted and never needs
 * it. Defaults to true on APIs where the concept doesn't apply.
 */
private fun canInstallPackages(ctx: Context): Boolean = runCatching {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.packageManager.canRequestPackageInstalls()
    else true
}.getOrDefault(true)

/** Opens the per-app "Install unknown apps" settings screen for this agent. */
private fun requestInstallPackages(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
        .setData(Uri.parse("package:${ctx.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { ctx.startActivity(intent) }
}

/** Whether device location services are currently on. A BYOD work profile
 *  can't force this; it can only keep prompting the user to enable it. */
private fun locationServicesOn(ctx: Context): Boolean = runCatching {
    val lm = ctx.getSystemService(android.location.LocationManager::class.java) ?: return@runCatching false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) lm.isLocationEnabled
    else @Suppress("DEPRECATION")
        lm.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER) ||
        lm.isProviderEnabled(android.location.LocationManager.NETWORK_PROVIDER)
}.getOrDefault(false)

/** Opens the system location toggle screen. */
private fun openLocationSettings(ctx: Context) {
    val intent = Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { ctx.startActivity(intent) }
}

/** Whether the agent can draw over other apps — needed for the full-screen
 *  location takeover overlay. Only requested in a work profile. */
private fun canOverlay(ctx: Context): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) Settings.canDrawOverlays(ctx) else true

/** Opens the per-app "Display over other apps" settings screen. */
private fun requestOverlay(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
    val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
        .setData(Uri.parse("package:${ctx.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { ctx.startActivity(intent) }
}

/**
 * Whether the agent's screen-capture accessibility service (RemoteControlService)
 * is enabled. It auto-confirms the MediaProjection consent so live screen mirror
 * can start hands-free. A Device Owner can *permit* the service
 * (setPermittedAccessibilityServices) but cannot enable it silently on stock
 * Android, so — like usage access — it's surfaced here for a one-time toggle.
 * Referenced by class name to avoid an app→command-executor module dependency.
 */
private fun isScreenCaptureEnabled(ctx: Context): Boolean = runCatching {
    val expected = ComponentName(ctx.packageName, "com.mdm.command.RemoteControlService")
    val flat = Settings.Secure.getString(
        ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
    ) ?: return false
    flat.split(':').any { ComponentName.unflattenFromString(it) == expected }
}.getOrDefault(false)

/** Opens the system Accessibility settings so the user can enable the service. */
private fun openAccessibilitySettings(ctx: Context) {
    val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { ctx.startActivity(intent) }
}

private fun hasUsageAccess(ctx: Context): Boolean {
    val ops = ctx.getSystemService(AppOpsManager::class.java) ?: return false
    val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
    } else {
        @Suppress("DEPRECATION")
        ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
    }
    return mode == AppOpsManager.MODE_ALLOWED
}

@Composable
fun PermissionsPanel(deviceOwner: Boolean, workProfile: Boolean = false) {
    val ctx = LocalContext.current
    // `tick` is bumped to force a re-evaluation of grant state after the user
    // returns from the permission dialog / Settings.
    var tick by remember { mutableStateOf(0) }

    val runtime = remember(tick) { neededRuntimePerms().map { it to hasRuntime(ctx, it.manifest) } }
    val usageGranted = remember(tick) { hasUsageAccess(ctx) }
    val batteryOk = remember(tick) { isIgnoringBattery(ctx) }
    // "Install apps" is only requested in a work profile (Profile Owner). A
    // Device Owner installs silently and never needs it, so it's not shown.
    val installAppsOk = remember(tick) { !workProfile || canInstallPackages(ctx) }
    // Location services can't be forced on in a work profile (device-wide
    // setting on a personal device) — we surface it and keep prompting instead.
    val locationOn = remember(tick) { locationServicesOn(ctx) }
    val locationOk = !workProfile || locationOn
    // Overlay ("display over other apps") powers the full-screen location
    // takeover; only relevant in a work profile.
    val overlayOn = remember(tick) { canOverlay(ctx) }
    val overlayOk = !workProfile || overlayOn
    // Screen-capture accessibility service — only relevant on a fully-managed
    // (Device Owner) device, where live screen mirror is available. A work
    // profile is never offered it: screen mirror is Device-Owner-gated and
    // blocked on BYOD for privacy. A Profile Owner is passed in as owner-like
    // (deviceOwner=true) to suppress the manual runtime-grant prompts, so gate
    // this on a *true* Device Owner — deviceOwner held but not a work profile.
    val trueDeviceOwner = deviceOwner && !workProfile
    val screenCaptureEnabled = remember(tick) { isScreenCaptureEnabled(ctx) }
    val screenCaptureOk = !trueDeviceOwner || screenCaptureEnabled
    val missing = runtime.filter { !it.second }.map { it.first.manifest }

    // Surface the battery-optimization dialog automatically every time the
    // enrolled home screen is entered — until the exemption is actually granted.
    // On OxygenOS/ColorOS (this is a OnePlus/Oppo problem in particular) the OEM
    // power manager FREEZES the agent in the background unless it's exempt: the
    // heartbeat loop stops, the cached debug-unlock hash goes stale, and queued
    // commands never run. The old behavior persisted a `batt_prompted` flag and
    // so prompted only ONCE EVER — a single dismissal silenced it forever and
    // left the device permanently frozen. Now we re-ask on each home entry while
    // still un-exempt; once the user grants it, isIgnoringBattery() is true and
    // this no-ops (no nagging). The manual "Allow background activity" button
    // below remains as the deliberate re-entry point + OEM-page deep link.
    // Re-prompt on every home-screen entry while something critical is missing.
    // Launch only ONE settings screen per entry (battery first — it's what keeps
    // us alive — then location for work mode) so we never stack two screens.
    LaunchedEffect(Unit) {
        when {
            !isIgnoringBattery(ctx) -> requestIgnoreBattery(ctx)
            workProfile && !locationServicesOn(ctx) -> openLocationSettings(ctx)
        }
    }

    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        tick++
        // Restart the service so it re-declares its foreground-service types
        // with the newly granted camera/mic/location permission (Android 14
        // ties those FGS types to holding the permission at start time).
        runCatching { com.mdm.command.CommandService.start(ctx) }
    }

    Card(Modifier.fillMaxWidth().padding(top = 16.dp)) {
        Column(Modifier.padding(16.dp)) {
            Text("Permissions", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(12.dp))

            runtime.forEach { (item, granted) ->
                PermRow(item.label, granted)
            }
            PermRow("Activity monitoring", usageGranted)
            PermRow("Background activity", batteryOk)
            if (trueDeviceOwner) PermRow("Screen capture", screenCaptureEnabled)
            if (workProfile) PermRow("Install apps", installAppsOk)
            if (workProfile) PermRow("Location services", locationOn)
            if (workProfile) PermRow("Display over apps", overlayOn)

            Spacer(Modifier.height(12.dp))
            if (!batteryOk) {
                OutlinedButton(
                    onClick = { requestIgnoreBattery(ctx); tick++ },
                    modifier = Modifier.fillMaxWidth()
                ) { Text("Allow background activity (stay connected)") }
                Spacer(Modifier.height(8.dp))
            }
            if (missing.isNotEmpty()) {
                Button(
                    onClick = { launcher.launch(missing.toTypedArray()) },
                    modifier = Modifier.fillMaxWidth()
                ) { Text("Grant app permissions") }
                Spacer(Modifier.height(8.dp))
            }
            if (!usageGranted) {
                OutlinedButton(
                    onClick = {
                        runCatching {
                            ctx.startActivity(
                                Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).apply {
                                    data = Uri.fromParts("package", ctx.packageName, null)
                                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                }
                            )
                        }
                        tick++
                    },
                    modifier = Modifier.fillMaxWidth()
                ) { Text("Enable activity monitoring") }
                Spacer(Modifier.height(8.dp))
            }
            if (trueDeviceOwner && !screenCaptureEnabled) {
                OutlinedButton(
                    onClick = { openAccessibilitySettings(ctx); tick++ },
                    modifier = Modifier.fillMaxWidth()
                ) { Text("Enable screen capture (accessibility)") }
                Spacer(Modifier.height(8.dp))
            }
            if (workProfile && !installAppsOk) {
                OutlinedButton(
                    onClick = { requestInstallPackages(ctx); tick++ },
                    modifier = Modifier.fillMaxWidth()
                ) { Text("Allow installing apps (work profile)") }
                Spacer(Modifier.height(8.dp))
            }
            if (workProfile && !locationOn) {
                OutlinedButton(
                    onClick = { openLocationSettings(ctx); tick++ },
                    modifier = Modifier.fillMaxWidth()
                ) { Text("Turn on location (work profile)") }
                Spacer(Modifier.height(8.dp))
            }
            if (workProfile && !overlayOn) {
                OutlinedButton(
                    onClick = { requestOverlay(ctx); tick++ },
                    modifier = Modifier.fillMaxWidth()
                ) { Text("Allow display over apps (work profile)") }
                Spacer(Modifier.height(8.dp))
            }
            if (missing.isEmpty() && usageGranted && batteryOk && installAppsOk && locationOk && overlayOk && screenCaptureOk) {
                Text("All permissions granted ✓", style = MaterialTheme.typography.bodyMedium)
            }
            TextButton(onClick = { tick++ }, modifier = Modifier.fillMaxWidth()) { Text("Re-check") }
        }
    }
}

@Composable
private fun PermRow(label: String, granted: Boolean) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Text(if (granted) "Granted" else "Needed", style = MaterialTheme.typography.bodyMedium)
    }
}

package com.mdm.telemetry

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import com.mdm.security.IntegrityChecker
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Collects the lightweight per-device snapshot every heartbeat. Intentionally
 * pull-only — no broadcast receivers / listeners — so it's cheap to invoke
 * from a [TelemetryWorker] (and from a synchronous CommandService call).
 *
 * Anything that requires runtime permission goes through a soft check; absence
 * of permission yields a null field rather than an exception. The server's
 * schema treats every field as nullable for exactly this reason.
 */
@Singleton
class TelemetryCollector @Inject constructor(
    @ApplicationContext private val context: Context,
    private val integrity: IntegrityChecker
) {

    data class Snapshot(
        val batteryPct: Int,
        val charging: Boolean,
        val network: String,                // wifi | cellular | ethernet | none
        val vpnActive: Boolean,             // true if any active network has TRANSPORT_VPN
        val ipAddress: String?,             // primary non-loopback v4, e.g. 192.168.1.42
        val macAddress: String?,            // hardware address of the active interface
        val ssid: String?,                  // Wi-Fi SSID if connected over wifi
        val storageFreeBytes: Long,
        val storageTotalBytes: Long,
        val rooted: Boolean,
        val androidVersion: String,
        val patchLevel: String,
        val manufacturer: String,
        val model: String,
        val sdk: Int,
        val screenOn: Boolean,              // display currently interactive (on) vs off/dozing
        val occurredAtIso: String
    )

    // Every reader here is individually guarded: a snapshot is fed into the
    // heartbeat, and the heartbeat is the agent's "online" signal. If ANY single
    // reader throws (some — e.g. battery/connectivity/integrity — can behave
    // differently or be restricted inside a work profile), it must degrade to a
    // best-effort field, NOT take down the whole snapshot and silently freeze the
    // heartbeat at "connecting". So snapshot() never throws.
    fun snapshot(): Snapshot {
        val battery = runCatching { readBattery() }.getOrDefault(-1 to false)
        val ig = runCatching { integrity.snapshot() }.getOrNull()
        val netInfo = readNetInfo()
        return Snapshot(
            batteryPct = battery.first,
            charging = battery.second,
            network = runCatching { readNetworkType() }.getOrDefault("unknown"),
            vpnActive = readVpnActive(),
            ipAddress = netInfo.ipv4,
            macAddress = netInfo.mac,
            ssid = readSsid(),
            storageFreeBytes = readFreeBytes(),
            storageTotalBytes = readTotalBytes(),
            rooted = ig?.rooted ?: false,
            androidVersion = ig?.androidVersion ?: Build.VERSION.RELEASE.orEmpty(),
            patchLevel = ig?.patchLevel ?: Build.VERSION.SECURITY_PATCH.orEmpty(),
            manufacturer = Build.MANUFACTURER.orEmpty(),
            model = Build.MODEL.orEmpty(),
            sdk = Build.VERSION.SDK_INT,
            screenOn = readScreenOn(),
            occurredAtIso = java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC).toString()
        )
    }

    /** Whether the display is currently on/interactive. isInteractive is true
     *  while the screen is on (even at the lock screen) and false when off or
     *  dozing — the same signal behind the SCREEN_ON/SCREEN_OFF events. */
    private fun readScreenOn(): Boolean = runCatching {
        val pm = context.getSystemService(android.os.PowerManager::class.java)
        pm?.isInteractive == true
    }.getOrDefault(false)

    /**
     * True if ANY currently-connected network has TRANSPORT_VPN. We can't
     * just check activeNetwork because a VPN run alongside Wi-Fi will often
     * have a separate network handle; we walk all networks for accuracy.
     */
    private fun readVpnActive(): Boolean {
        return try {
            val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
            val nets = cm.allNetworks
            for (n in nets) {
                val caps = cm.getNetworkCapabilities(n) ?: continue
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return true
            }
            false
        } catch (_: Throwable) { false }
    }

    private data class NetInfo(val ipv4: String?, val mac: String?)

    /**
     * Walks NetworkInterface to find the first non-loopback up interface with
     * an IPv4 address; returns that address + the interface's hardware MAC.
     *
     * On Android 6+ the MAC reported here is the per-network randomised MAC,
     * not the burned-in MAC — that's intentional Android privacy and
     * matches what shows on the router's lease list.
     */
    private fun readNetInfo(): NetInfo {
        return try {
            val all = java.net.NetworkInterface.getNetworkInterfaces() ?: return NetInfo(null, null)
            for (nif in all) {
                if (!nif.isUp || nif.isLoopback || nif.isVirtual) continue
                val ipv4 = nif.inetAddresses.toList().firstOrNull {
                    it is java.net.Inet4Address && !it.isLoopbackAddress && !it.isLinkLocalAddress
                }?.hostAddress
                if (ipv4 != null) {
                    val mac = nif.hardwareAddress?.joinToString(":") { "%02x".format(it) }
                    return NetInfo(ipv4, mac)
                }
            }
            NetInfo(null, null)
        } catch (_: Throwable) { NetInfo(null, null) }
    }

    @Suppress("DEPRECATION")
    private fun readSsid(): String? = try {
        val wm = context.getSystemService(android.net.wifi.WifiManager::class.java) ?: return null
        val info = wm.connectionInfo ?: return null
        info.ssid?.removeSurrounding("\"")?.takeIf { it.isNotEmpty() && it != "<unknown ssid>" }
    } catch (_: Throwable) { null }

    private fun readBattery(): Pair<Int, Boolean> {
        val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        @Suppress("DEPRECATION")
        val intent = context.registerReceiver(null, filter) ?: return -1 to false
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        val pct = if (level >= 0 && scale > 0) (level * 100 / scale) else -1
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                       status == BatteryManager.BATTERY_STATUS_FULL
        return pct to charging
    }

    private fun readNetworkType(): String {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return "unknown"
        val net = cm.activeNetwork ?: return "none"
        val caps = cm.getNetworkCapabilities(net) ?: return "none"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
    }

    private fun readFreeBytes(): Long = try {
        val stat = StatFs(Environment.getDataDirectory().path)
        stat.availableBlocksLong * stat.blockSizeLong
    } catch (_: Throwable) { -1 }

    private fun readTotalBytes(): Long = try {
        val stat = StatFs(Environment.getDataDirectory().path)
        stat.blockCountLong * stat.blockSizeLong
    } catch (_: Throwable) { -1 }
}

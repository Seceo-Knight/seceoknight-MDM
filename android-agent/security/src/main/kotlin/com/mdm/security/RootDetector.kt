package com.mdm.security

import android.os.Build
import timber.log.Timber
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Best-effort root / tamper detection. None of these checks are sufficient on
 * their own — together they raise the bar for a casual attacker. Determined
 * adversaries with Magisk Zygisk or similar can defeat any userland check.
 *
 * Used by [IntegrityChecker] to decide whether to admit a device to enrollment
 * and to ship `root_detected=true` in telemetry so the server can compliance-flag.
 */
@Singleton
class RootDetector @Inject constructor() {

    fun isRooted(): Boolean {
        val checks = listOf(
            ::hasSuBinary to "su_binary",
            ::hasMagiskMarkers to "magisk",
            ::hasTestKeys to "test_keys",
            ::hasDangerousProps to "dangerous_props",
            ::hasRwSystem to "rw_system"
        )
        val hits = checks.filter { (check, _) -> check() }.map { it.second }
        if (hits.isNotEmpty()) Timber.w("Root indicators: $hits")
        return hits.isNotEmpty()
    }

    private fun hasSuBinary(): Boolean = SU_PATHS.any { File(it).exists() }

    private fun hasMagiskMarkers(): Boolean = MAGISK_PATHS.any { File(it).exists() }

    private fun hasTestKeys(): Boolean =
        Build.TAGS != null && Build.TAGS.contains("test-keys")

    private fun hasDangerousProps(): Boolean = runCatching {
        val p = Runtime.getRuntime().exec("getprop")
        // Hard-bound the subprocess. On locked-down / aggressively-frozen OEM ROMs
        // (e.g. ColorOS "OSense") the `getprop` child can be frozen and never exit,
        // and an unbounded waitFor() then blocks the CALLER forever — which is what
        // wedged enrollment (integrity.snapshot() runs this synchronously, so the
        // spinner never resolved and no enroll request was ever sent). Cap the
        // wait, kill the process if it overruns, and degrade to "no hit".
        if (!p.waitFor(GETPROP_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)) {
            runCatching { p.destroyForcibly() }
            return false
        }
        val out = p.inputStream.bufferedReader().readText()
        DANGEROUS_PROPS.any { out.contains(it) }
    }.getOrDefault(false)

    private fun hasRwSystem(): Boolean = runCatching {
        File("/proc/mounts").bufferedReader().useLines { lines ->
            lines.any { (it.contains(" /system ") || it.contains(" /vendor ")) && it.contains(" rw,") }
        }
    }.getOrDefault(false)

    private companion object {
        val SU_PATHS = listOf(
            "/system/bin/su", "/system/xbin/su", "/sbin/su",
            "/system/sd/xbin/su", "/system/bin/failsafe/su", "/data/local/su",
            "/data/local/bin/su", "/data/local/xbin/su", "/su/bin/su"
        )
        val MAGISK_PATHS = listOf(
            "/sbin/.magisk", "/sbin/.core/mirror", "/sbin/.core/img",
            "/cache/.disable_magisk", "/dev/.magisk.unblock", "/cache/magisk.log",
            "/data/adb/magisk"
        )
        val DANGEROUS_PROPS = listOf(
            "ro.debuggable=[1]",
            "ro.secure=[0]",
            "service.adb.root=[1]"
        )
        /** Max time to wait on the `getprop` subprocess before abandoning it. */
        const val GETPROP_TIMEOUT_MS = 2_000L
    }
}

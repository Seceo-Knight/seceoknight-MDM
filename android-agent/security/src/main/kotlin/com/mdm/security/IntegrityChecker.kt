package com.mdm.security

import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import dagger.hilt.android.qualifiers.ApplicationContext
import timber.log.Timber
import java.security.MessageDigest
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Aggregates the lightweight on-device integrity signals the agent reports to
 * the server with every telemetry batch. Heavy attestation (Play Integrity
 * API) is intentionally out of scope here — we ship a token from the agent
 * and let the server call Google's API for verification.
 *
 * The signal set:
 *  - rooted: any indicator from [RootDetector]
 *  - debuggable: this build was compiled with android:debuggable
 *  - adbEnabled: settings flag is on (informational only)
 *  - selfSignatureSha256: lets the server detect repackaged/sideloaded APKs
 */
@Singleton
class IntegrityChecker @Inject constructor(
    @ApplicationContext private val context: Context,
    private val rootDetector: RootDetector
) {

    data class Report(
        val rooted: Boolean,
        val debuggable: Boolean,
        val adbEnabled: Boolean,
        val emulator: Boolean,
        val selfSignatureSha256: String,
        val androidVersion: String,
        val patchLevel: String
    )

    fun snapshot(): Report = Report(
        rooted = rootDetector.isRooted(),
        debuggable = isDebuggable(),
        adbEnabled = isAdbEnabled(),
        emulator = isEmulator(),
        selfSignatureSha256 = selfSignatureSha256(),
        androidVersion = Build.VERSION.RELEASE.orEmpty(),
        patchLevel = Build.VERSION.SECURITY_PATCH.orEmpty()
    )

    /**
     * Like [snapshot] but SKIPS the root probe — the only part that shells out to
     * a subprocess (`getprop`) / reads /proc and can therefore block on a frozen
     * OEM ROM. Used as the enrollment fallback when the full snapshot times out so
     * a wedged root check can never stall enrollment. `rooted` defaults to false
     * (degraded, not a hard fail); telemetry re-evaluates it later off the critical
     * path.
     */
    fun quickSnapshot(): Report = Report(
        rooted = false,
        debuggable = isDebuggable(),
        adbEnabled = isAdbEnabled(),
        emulator = isEmulator(),
        selfSignatureSha256 = selfSignatureSha256(),
        androidVersion = Build.VERSION.RELEASE.orEmpty(),
        patchLevel = Build.VERSION.SECURITY_PATCH.orEmpty()
    )

    private fun isDebuggable(): Boolean =
        (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0

    private fun isAdbEnabled(): Boolean = try {
        android.provider.Settings.Global.getInt(
            context.contentResolver,
            android.provider.Settings.Global.ADB_ENABLED, 0
        ) == 1
    } catch (t: Throwable) { false }

    private fun isEmulator(): Boolean {
        return Build.FINGERPRINT.startsWith("generic")
            || Build.FINGERPRINT.startsWith("unknown")
            || Build.MODEL.contains("google_sdk")
            || Build.MODEL.contains("Emulator")
            || Build.MODEL.contains("Android SDK built for x86")
            || Build.MANUFACTURER.contains("Genymotion")
            || (Build.BRAND.startsWith("generic") && Build.DEVICE.startsWith("generic"))
            || "google_sdk" == Build.PRODUCT
    }

    private fun selfSignatureSha256(): String = try {
        @Suppress("DEPRECATION")
        val sigs: Array<Signature> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val info = context.packageManager.getPackageInfo(
                context.packageName, PackageManager.GET_SIGNING_CERTIFICATES
            )
            info.signingInfo?.apkContentsSigners ?: emptyArray()
        } else {
            context.packageManager.getPackageInfo(
                context.packageName, PackageManager.GET_SIGNATURES
            ).signatures
        }
        val digest = MessageDigest.getInstance("SHA-256")
        sigs.forEach { digest.update(it.toByteArray()) }
        digest.digest().joinToString("") { "%02x".format(it) }
    } catch (t: Throwable) {
        Timber.w(t, "Failed to compute self signature"); ""
    }
}

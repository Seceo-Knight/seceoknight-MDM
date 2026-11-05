package com.mdm.agent

import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.view.WindowManager
import androidx.activity.ComponentActivity
import com.mdm.core.admin.DevicePolicyController
import dagger.hilt.android.AndroidEntryPoint
import timber.log.Timber
import javax.inject.Inject

/**
 * Transparent, no-UI activity that turns the screen on — the remote equivalent of
 * a power-button press. Launched (by class name) from the WAKE_DEVICE command
 * handler. The live screen mirror (MediaProjection) only captures a *rendering*
 * display, so when the screen turns off the capture goes black and the WebRTC
 * session dies; an admin uses this to wake the device and bring the mirror back.
 *
 * Uses the same proven wake path as [ProjectionRequestActivity]: setTurnScreenOn +
 * FLAG_TURN_SCREEN_ON reliably light the display from a fully-off/locked state on
 * modern Android (the deprecated FULL_WAKE_LOCK no longer does). Device Owner only.
 */
@AndroidEntryPoint
class WakeActivity : ComponentActivity() {
    @Inject lateinit var dpm: DevicePolicyController

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Defense in depth: waking the screen is a Device-Owner-only control — it
        // exists only to revive the owner-gated screen mirror. The command handler
        // already refuses non-DO; guarding here too means a stale/misrouted
        // WAKE_DEVICE can never light up a personal/BYOD device's screen.
        if (!dpm.isDeviceOwner()) {
            Timber.w("wake: WAKE_DEVICE on a non-Device-Owner device — refusing")
            finish()
            return
        }
        // The modern, reliable way to wake the screen from off/locked: ask the
        // window to turn the display on and show over the keyguard (a bare
        // wakelock no longer lights the screen on recent Android).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true); setTurnScreenOn(true)
        }
        window.addFlags(
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        )
        // Belt-and-suspenders: a short wake-causing wakelock kicks the device out
        // of Doze so the turn-screen-on flag actually fires from deep sleep. Same
        // flags the screen-share manager uses to keep the display lit.
        runCatching {
            @Suppress("DEPRECATION")
            getSystemService(PowerManager::class.java)?.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "mdm:wake"
            )?.apply { setReferenceCounted(false); acquire(3_000L) }
        }.onFailure { Timber.w(it, "wake: wakelock failed") }
        // Hold this (transparent) activity briefly so the display is definitely on
        // and an active screen-share's own SCREEN_BRIGHT_WAKE_LOCK can take over
        // keeping it lit, then get out of the way.
        Handler(Looper.getMainLooper()).postDelayed({ if (!isFinishing) finish() }, 2_500L)
    }
}

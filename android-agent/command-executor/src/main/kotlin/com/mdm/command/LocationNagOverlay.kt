package com.mdm.command

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import timber.log.Timber

/**
 * A full-screen "turn on location" takeover drawn as a SYSTEM_ALERT_WINDOW
 * overlay — far more intrusive than a notification: it covers whatever the user
 * is doing and stays on top until they act. Driven by the heartbeat while the
 * agent is a Profile Owner and device location is OFF, and removed the instant
 * location comes back on.
 *
 * It is deliberately escapable in exactly one way — the "Turn on location"
 * button, which opens the location settings and hides the overlay. If the user
 * dismisses it without actually enabling location, the next heartbeat throws it
 * straight back up. Requires the "display over other apps" permission
 * (SYSTEM_ALERT_WINDOW), which the permissions panel requests in work-profile
 * mode. All window ops run on the main thread; failures are swallowed.
 */
object LocationNagOverlay {
    private val main = Handler(Looper.getMainLooper())
    private var view: View? = null

    fun show(context: Context) {
        val ctx = context.applicationContext
        // No permission → can't draw. The panel nags for it; the notification
        // path still fires regardless.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(ctx)) return
        main.post {
            if (view != null) return@post
            val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as? WindowManager ?: return@post
            val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
            val lp = WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                type,
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
                    WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
                PixelFormat.OPAQUE
            )
            val root = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setBackgroundColor(Color.parseColor("#F20B1020"))
                setPadding(72, 72, 72, 72)
                // Swallow taps so the app underneath can't be used — the only way
                // through is the button.
                isClickable = true
            }
            val title = TextView(ctx).apply {
                text = "⚠  Location is turned OFF"
                setTextColor(Color.WHITE); textSize = 26f
                gravity = Gravity.CENTER
            }
            val msg = TextView(ctx).apply {
                text = "Your work profile requires location services to be ON. " +
                    "You can't continue using this device until location is enabled."
                setTextColor(Color.parseColor("#C9D4E5")); textSize = 16f
                gravity = Gravity.CENTER
                setPadding(0, 36, 0, 56)
            }
            val btn = Button(ctx).apply {
                text = "Turn on location"
                setOnClickListener {
                    runCatching {
                        ctx.startActivity(
                            Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        )
                    }
                    hide() // let them reach the toggle; reappears next heartbeat if still off
                }
            }
            root.addView(title); root.addView(msg); root.addView(btn)
            runCatching { wm.addView(root, lp); view = root }
                .onFailure { Timber.w(it, "location overlay add failed") }
        }
    }

    fun hide() {
        main.post {
            val v = view ?: return@post
            val wm = v.context.applicationContext
                .getSystemService(Context.WINDOW_SERVICE) as? WindowManager
            runCatching { wm?.removeView(v) }
            view = null
        }
    }
}

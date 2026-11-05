package com.mdm.command

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.util.DisplayMetrics
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import timber.log.Timber

/**
 * Accessibility service for the screen-share feature.
 *
 *  - **Phase 1:** auto-confirm the system MediaProjection "Start now" consent
 *    dialog so capture is silent on a managed device.
 *  - **Phase 2:** inject remote-control input — tap/swipe via `dispatchGesture`,
 *    home/back/recents via `performGlobalAction`, and best-effort text into the
 *    focused field — driven by the admin browser over the screen-share "control"
 *    data channel ([WebRtcScreenShareManager] routes messages to [instance]).
 *
 * Reality check: a Device Owner can *permit* this service
 * (`setPermittedAccessibilityServices`) but cannot *enable* it silently on stock
 * Android — enabling still needs a one-time user/adb action (or Samsung Knox).
 * Without it, the projection flow falls back to a one-time "Start now" tap.
 */
class RemoteControlService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        return super.onUnbind(intent)
    }

    // ---- Phase 2: remote input injection (driven by the screen-share data
    // channel). Coords are normalized [0,1] in the captured-frame space; we scale
    // to the live display so they stay correct across rotation/resolution. ----

    private fun screen(): Pair<Float, Float> {
        // Scale against the FULL physical display (incl. status/nav bars) — that's
        // the coordinate space MediaProjection captures AND that dispatchGesture
        // addresses. resources.displayMetrics excludes the system bars on many OEMs,
        // which made taps land short (a bit above the click, worse near the bottom).
        runCatching {
            val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val b = wm.maximumWindowMetrics.bounds
                return b.width().toFloat() to b.height().toFloat()
            }
            val dm = DisplayMetrics()
            @Suppress("DEPRECATION") wm.defaultDisplay.getRealMetrics(dm)
            return dm.widthPixels.toFloat() to dm.heightPixels.toFloat()
        }
        val dm = resources.displayMetrics
        return dm.widthPixels.toFloat() to dm.heightPixels.toFloat()
    }

    fun injectTap(nx: Float, ny: Float) {
        val (w, h) = screen()
        val path = Path().apply { moveTo((nx * w).coerceIn(0f, w - 1), (ny * h).coerceIn(0f, h - 1)) }
        runCatching {
            dispatchGesture(GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path, 0, 60)).build(), null, null)
        }
    }

    fun injectSwipe(nx1: Float, ny1: Float, nx2: Float, ny2: Float, durationMs: Long) {
        val (w, h) = screen()
        val path = Path().apply { moveTo(nx1 * w, ny1 * h); lineTo(nx2 * w, ny2 * h) }
        val dur = durationMs.coerceIn(40, 2000)
        runCatching {
            dispatchGesture(GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path, 0, dur)).build(), null, null)
        }
    }

    fun injectGlobal(action: String) {
        val a = when (action) {
            "home" -> GLOBAL_ACTION_HOME
            "back" -> GLOBAL_ACTION_BACK
            "recents" -> GLOBAL_ACTION_RECENTS
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            else -> return
        }
        runCatching { performGlobalAction(a) }
    }

    /** Best-effort text into the focused editable field (append / backspace). */
    fun injectText(text: String, backspace: Boolean) {
        val node = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return
        val cur = node.text?.toString() ?: ""
        val next = if (backspace) cur.dropLast(1) else cur + text
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, next)
        }
        runCatching { node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args) }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val type = event?.eventType ?: return
        if (type != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            type != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) return
        // Only act on the system screen-capture dialog (drawn by SystemUI), never
        // random app windows. Accept any *systemui* package (OEM skins vary) plus a
        // small explicit set; allow null/unknown through so we never miss it.
        val pkg = event.packageName?.toString()
        if (pkg != null && !pkg.contains("systemui", ignoreCase = true) && pkg !in CONSENT_PACKAGES) return
        val root = rootInActiveWindow ?: return

        // 1) Locale-independent: click the dialog's positive button by resource id.
        //    Needs flagReportViewIds in the service config. This is the reliable
        //    path on OxygenOS/AOSP where the confirm button is android:id/button1.
        for (id in CONSENT_BUTTON_IDS) {
            val nodes = runCatching { root.findAccessibilityNodeInfosByViewId(id) }.getOrNull().orEmpty()
            for (n in nodes) {
                if (n.isVisibleToUser && clickSelfOrAncestor(n)) {
                    Timber.i("screen: auto-confirmed projection consent (id=$id)")
                    return
                }
            }
        }
        // 2) Fallback: match the confirm button by visible text (locale variants).
        for (label in CONSENT_LABELS) {
            val nodes = runCatching { root.findAccessibilityNodeInfosByText(label) }.getOrNull().orEmpty()
            for (n in nodes) {
                if (clickSelfOrAncestor(n)) {
                    Timber.i("screen: auto-confirmed projection consent ('$label')")
                    return
                }
            }
        }
    }

    /** Click the node if clickable, else walk up to the nearest clickable ancestor. */
    private fun clickSelfOrAncestor(node: AccessibilityNodeInfo): Boolean {
        var n: AccessibilityNodeInfo? = node
        var hops = 0
        while (n != null && hops < 6) {
            if (n.isClickable && n.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
            n = n.parent
            hops++
        }
        return false
    }

    override fun onInterrupt() {}

    companion object {
        /** Live instance, set while the accessibility service is connected, used by
         *  the screen-share data channel to inject remote input. Null when off. */
        @Volatile var instance: RemoteControlService? = null

        // The MediaProjection consent dialog is drawn by SystemUI; restrict the
        // auto-tap to those packages so we never click anything else.
        private val CONSENT_PACKAGES = setOf("com.android.systemui", "android")
        // The dialog's positive button by resource id — locale-independent and the
        // most reliable target across OEM skins (framework AlertDialog = button1).
        private val CONSENT_BUTTON_IDS = listOf("android:id/button1", "com.android.systemui:id/button1")
        // Text fallback for skins that don't expose the framework button id —
        // cover common English variants (extend per target locale).
        private val CONSENT_LABELS = listOf("Start now", "START NOW", "Start recording", "Start casting", "Allow", "Start")
    }
}

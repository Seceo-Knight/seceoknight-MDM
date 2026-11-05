package com.mdm.command

import android.app.Activity
import android.app.AlertDialog
import android.os.Build
import android.os.Bundle

/**
 * Shows an admin-pushed message as a dialog on the device screen. Launched by
 * the SHOW_MESSAGE command (directly and/or via a full-screen-intent
 * notification). Marked show-when-locked + turn-screen-on so an urgent message
 * surfaces even on a locked device.
 */
class MessageActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
        val title = intent.getStringExtra("title")?.takeIf { it.isNotBlank() } ?: "Message"
        val message = intent.getStringExtra("message").orEmpty()
        AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(message)
            .setCancelable(true)
            .setPositiveButton(android.R.string.ok) { _, _ -> finish() }
            .setOnDismissListener { finish() }
            .show()
    }
}

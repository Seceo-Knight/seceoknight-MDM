package com.mdm.core.admin

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.time.OffsetDateTime
import java.time.ZoneOffset

/**
 * The agent's "black box": a small, durable on-device queue of tamper events
 * plus the integrity baseline used to detect change. Plain SharedPreferences
 * (not encrypted) on purpose — these records must survive the agent being
 * force-stopped or its admin role being revoked, and must be readable from both
 * :mdm-core (the DeviceAdminReceiver that records "admin removed") and
 * :command-executor (the TamperGuard that detects SIM/root changes and
 * exfiltrates the queue on the next connection/boot).
 */
class TamperStore(context: Context) {
    private val prefs = context.getSharedPreferences("mdm_tamper", Context.MODE_PRIVATE)

    /** Append a tamper event to the durable queue (best-effort, never throws). */
    fun enqueue(type: String, detail: String) {
        runCatching {
            val arr = JSONArray(prefs.getString(KEY_QUEUE, "[]"))
            arr.put(
                JSONObject()
                    .put("type", type)
                    .put("detail", detail)
                    .put("captured_at", OffsetDateTime.now(ZoneOffset.UTC).toString())
            )
            prefs.edit().putString(KEY_QUEUE, arr.toString()).apply()
        }
    }

    /** Returns and clears the queued events. */
    fun drain(): List<JSONObject> {
        val out = ArrayList<JSONObject>()
        runCatching {
            val arr = JSONArray(prefs.getString(KEY_QUEUE, "[]"))
            for (i in 0 until arr.length()) out.add(arr.getJSONObject(i))
        }
        prefs.edit().remove(KEY_QUEUE).apply()
        return out
    }

    var simSerial: String?
        get() = prefs.getString(KEY_SIM, null)
        set(v) { prefs.edit().putString(KEY_SIM, v).apply() }

    var rooted: Boolean
        get() = prefs.getBoolean(KEY_ROOTED, false)
        set(v) { prefs.edit().putBoolean(KEY_ROOTED, v).apply() }

    /** False until the first baseline has been recorded (so the first run isn't a "change"). */
    var baselineInit: Boolean
        get() = prefs.getBoolean(KEY_BASELINE, false)
        set(v) { prefs.edit().putBoolean(KEY_BASELINE, v).apply() }

    private companion object {
        const val KEY_QUEUE = "queue"
        const val KEY_SIM = "sim_serial"
        const val KEY_ROOTED = "rooted"
        const val KEY_BASELINE = "baseline_init"
    }
}

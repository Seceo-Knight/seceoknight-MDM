package com.mdm.enrollment

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Parses the QR-code payload the admin console issues for new device
 * provisioning, for the IN-APP "Scan QR" enrollment flow.
 *
 * Two shapes are accepted so the SAME console QR works whether it's scanned at
 * the Setup Wizard or inside the running app:
 *   - agent-format JSON: { server_url, enrollment_token, tenant_id,
 *     provisioning_mode };
 *   - the AOSP Device-Owner bundle, where those keys live nested under
 *     `android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE`.
 */
@Serializable
data class QrPayload(
    val server_url: String,
    val enrollment_token: String,
    val tenant_id: String = "",
    val provisioning_mode: String? = null
)

object QrEnrollmentParser {

    private const val ADMIN_EXTRAS = "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE"
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    fun parse(raw: String): Result<QrPayload> = runCatching {
        val root = json.parseToJsonElement(raw).jsonObject
        // If this is the AOSP provisioning bundle, our keys are nested.
        val obj = root[ADMIN_EXTRAS]?.jsonObject ?: root
        fun str(k: String): String? = obj[k]?.jsonPrimitive?.contentOrNull
        QrPayload(
            server_url = str("server_url") ?: error("server_url missing from QR"),
            enrollment_token = str("enrollment_token") ?: error("enrollment_token missing from QR"),
            tenant_id = str("tenant_id") ?: "",
            provisioning_mode = str("provisioning_mode")
        )
    }
}

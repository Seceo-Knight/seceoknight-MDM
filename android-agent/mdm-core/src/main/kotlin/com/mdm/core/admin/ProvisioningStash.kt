package com.mdm.core.admin

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Persists the provisioning extras received during DPC provisioning so the
 * agent can complete enrollment on first launch.
 *
 * Uses EncryptedSharedPreferences (AES-256-SIV/GCM via Tink) backed by the
 * Android Keystore, so the enrollment token isn't visible to anyone who can
 * read disk.
 */
class ProvisioningStash(context: Context) {

    private val prefs = EncryptedSharedPreferences.create(
        context,
        FILE,
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    fun save(serverUrl: String, token: String, tenantId: String, channel: String = "qr_setup") {
        prefs.edit()
            .putString(K_SERVER, serverUrl)
            .putString(K_TOKEN, token)
            .putString(K_TENANT, tenantId)
            .putString(K_CHANNEL, channel)
            .apply()
    }

    fun read(): Triple<String, String, String>? {
        val s = prefs.getString(K_SERVER, null) ?: return null
        val t = prefs.getString(K_TOKEN, null) ?: return null
        val ten = prefs.getString(K_TENANT, "") ?: ""
        return Triple(s, t, ten)
    }

    /** How this device was provisioned (qr_setup | qr_inapp | direct_install | adb). */
    fun channel(): String = prefs.getString(K_CHANNEL, "qr_setup") ?: "qr_setup"

    fun clear() = prefs.edit().clear().apply()

    private companion object {
        const val FILE = "mdm_provisioning"
        const val K_SERVER = "server"
        const val K_TOKEN  = "token"
        const val K_TENANT = "tenant"
        const val K_CHANNEL = "channel"
    }
}

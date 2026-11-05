package com.mdm.core.admin

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import java.security.SecureRandom
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Persists the per-device reset-password token. The token is 32 random bytes
 * stashed in EncryptedSharedPreferences. We use a single stable token per
 * device install — rotating it would just invalidate the user's prior
 * "credential confirm" step and require them to re-activate.
 */
@Singleton
class ResetPasswordTokenStore @Inject constructor(
    @ApplicationContext private val context: Context
) {
    private val prefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context,
            "mdm_reset_pw_token",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    fun getOrCreate(): ByteArray {
        val existing = prefs.getString(KEY, null)
        if (existing != null) return android.util.Base64.decode(existing, android.util.Base64.NO_WRAP)
        val token = ByteArray(32).also { SecureRandom().nextBytes(it) }
        prefs.edit().putString(KEY, android.util.Base64.encodeToString(token, android.util.Base64.NO_WRAP)).apply()
        return token
    }

    private companion object { const val KEY = "token_b64" }
}

package com.mdm.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import timber.log.Timber
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Hardware-backed crypto for anything that doesn't fit EncryptedSharedPreferences —
 * e.g. one-off blob encryption, payload signing keys.
 *
 * Keys are stored in the AndroidKeyStore with `setUserAuthenticationRequired(false)`
 * (device-bound but not user-auth-bound, since the agent must operate when the
 * screen is locked). Where stronger guarantees are required, callers should
 * opt into [setStrongBox] and accept the StrongBox availability tradeoff.
 */
@Singleton
class CryptoManager @Inject constructor() {

    private val keyStore: KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    fun encrypt(alias: String, plaintext: ByteArray): EncryptedBlob {
        val key = getOrCreateKey(alias)
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key) }
        val iv = cipher.iv
        val ct = cipher.doFinal(plaintext)
        return EncryptedBlob(iv, ct)
    }

    fun decrypt(alias: String, blob: EncryptedBlob): ByteArray {
        val key = (keyStore.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.secretKey
            ?: error("Key '$alias' not found")
        val cipher = Cipher.getInstance(TRANSFORMATION).apply {
            init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, blob.iv))
        }
        return cipher.doFinal(blob.ciphertext)
    }

    fun deleteKey(alias: String) {
        runCatching { keyStore.deleteEntry(alias) }
            .onFailure { Timber.w(it, "Failed to delete key $alias") }
    }

    private fun getOrCreateKey(alias: String): SecretKey {
        keyStore.getEntry(alias, null)?.let {
            return (it as KeyStore.SecretKeyEntry).secretKey
        }
        val spec = KeyGenParameterSpec.Builder(alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
            .apply { init(spec) }
            .generateKey()
    }

    data class EncryptedBlob(val iv: ByteArray, val ciphertext: ByteArray) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is EncryptedBlob) return false
            return iv.contentEquals(other.iv) && ciphertext.contentEquals(other.ciphertext)
        }
        override fun hashCode(): Int = 31 * iv.contentHashCode() + ciphertext.contentHashCode()
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
    }
}

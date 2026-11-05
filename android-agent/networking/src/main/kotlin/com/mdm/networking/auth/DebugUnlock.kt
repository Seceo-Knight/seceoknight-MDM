package com.mdm.networking.auth

import java.security.MessageDigest

/**
 * Local, offline verification of the global debug-unlock password that gates the
 * hidden in-app config panel.
 *
 * The server delivers only the HASH (never the plaintext) at enrollment and on
 * every heartbeat; we cache it in [TokenStore.debugUnlockHash]. When the operator
 * types a password in the panel we hash it the same way and compare — no network
 * needed, which is the whole point (they're repointing the server precisely
 * because it's unreachable).
 *
 * SALT must stay byte-for-byte identical to the server's
 * device-service/internal/service.debugUnlockSalt.
 */
object DebugUnlock {
    private const val SALT = "cybersentinel:debug-unlock:v1:"

    /** hex sha256(SALT + input), matching the server. */
    fun hash(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest((SALT + input).toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    /** Constant-ish local check of a typed password against the cached hash. */
    fun verify(input: String, cachedHash: String?): Boolean {
        if (cachedHash.isNullOrBlank() || input.isEmpty()) return false
        return hash(input).equals(cachedHash, ignoreCase = true)
    }
}

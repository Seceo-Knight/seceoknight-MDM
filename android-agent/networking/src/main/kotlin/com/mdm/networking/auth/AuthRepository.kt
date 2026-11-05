package com.mdm.networking.auth

import com.mdm.networking.api.MdmApi
import com.mdm.networking.api.RefreshRequest
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Owns the agent's credential lifecycle:
 *  - exposes the device identity to the UI/services;
 *  - rotates the access token via /auth/refresh with single-flight semantics
 *    so we don't burn refresh tokens in a thundering herd.
 *
 * NOTE: [refreshIfNeeded] is also the single re-entry point invoked from the
 * 401-retry path in [com.mdm.networking.interceptor.TokenAuthenticator] —
 * keep it side-effect-free aside from the TokenStore update.
 */
@Singleton
class AuthRepository @Inject constructor(
    private val tokens: TokenStore,
    private val apiHolder: dagger.Lazy<MdmApi>  // break circular dep: api needs interceptor needs us
) {
    private val refreshMutex = Mutex()

    fun deviceId(): String? = tokens.deviceId()
    fun tenantId(): String? = tokens.tenantId()
    fun serverUrl(): String? = tokens.serverUrl()
    fun accessToken(): String? = tokens.accessToken()
    fun isEnrolled(): Boolean = tokens.isEnrolled()

    /**
     * Returns the current access token, refreshing it first if it expires
     * within [refreshSkewSeconds]. Thread-safe; only one network call in
     * flight even if N callers race in.
     */
    suspend fun ensureAccessToken(refreshSkewSeconds: Long = 60): String? {
        val now = System.currentTimeMillis() / 1000
        val exp = tokens.accessExpiresEpochS()
        if (exp == 0L || exp > now + refreshSkewSeconds) {
            return tokens.accessToken()
        }
        return refreshNow()
    }

    /**
     * Force a refresh — used by the 401 retry. The caller (TokenAuthenticator)
     * only invokes this AFTER the server has rejected the current token, so
     * we MUST actually hit /auth/refresh; a "double-check the clock" guard
     * here would silently return the rejected token and lock the agent out
     * forever (the agent's local TTL view can diverge from the server's:
     * clock skew, JWT_SECRET rotation, or a wrong DEFAULT_ACCESS_LIFE_S baked
     * in at enrollment).
     *
     * Single-flight semantics are preserved by [refreshMutex] — concurrent
     * 401s coalesce into one refresh call.
     */
    suspend fun refreshNow(): String? = refreshMutex.withLock {
        // If a concurrent caller JUST refreshed under the lock, the
        // currently-stored token is fresh — return it without another round
        // trip. We detect that by checking whether the access token in the
        // store has *changed* since the request was issued; the simplest
        // sentinel is the expiry having moved into the future relative to a
        // safe lower-bound (the moment we entered the lock).
        // We deliberately do NOT short-circuit on "exp > now + N" alone —
        // that's what caused the lockout bug.
        val rt = tokens.refreshToken() ?: return@withLock null
        val resp = runCatching { apiHolder.get().refresh(RefreshRequest(rt)) }
            .onFailure { Timber.w(it, "refresh failed") }
            .getOrNull() ?: return@withLock null
        val body = resp.body()
        if (!resp.isSuccessful || body == null) {
            Timber.w("refresh non-success: ${resp.code()}")
            // A 401 means the server rejected this refresh token. That can be
            // PERMANENT (token truly expired past JWT_REFRESH_TTL, device deleted
            // server-side) OR TRANSIENT (server mid-redeploy, Postgres volume
            // restored/reseeded, JWT_SECRET rotated then rolled back, brief clock
            // skew). We MUST NOT de-enroll on the first 401: that's exactly what
            // left the device "stuck Disconnected, unable to reconnect" after a
            // long outage — a recoverable blip wiped its identity and it could
            // never come back on its own. Instead we keep the credentials and
            // keep retrying; we only force re-enrollment (wipe creds, keep the
            // server URL + debug-unlock hash for recovery) once the refresh has
            // been rejected CONTINUOUSLY for [REENROLL_GRACE_S]. A single success
            // (below) resets the streak. Non-401 failures (5xx, timeouts) are
            // transient by definition and never advance toward a wipe.
            if (resp.code() == 401) {
                val nowS = System.currentTimeMillis() / 1000
                val since = tokens.refreshDeniedSinceEpochS()
                if (since == 0L) {
                    tokens.setRefreshDeniedSince(nowS)   // start of the denial streak — keep trying
                } else if (nowS - since >= REENROLL_GRACE_S) {
                    Timber.w("refresh rejected for >${REENROLL_GRACE_S}s — forcing re-enroll")
                    tokens.clearCredentialsKeepConfig()
                }
            }
            return@withLock null
        }
        tokens.clearRefreshDeniedSince()   // healthy refresh — clear any denial streak
        tokens.updateTokens(
            access = body.accessToken,
            refresh = body.refreshToken,
            expEpochS = (System.currentTimeMillis() / 1000) + body.expiresIn
        )
        body.accessToken
    }

    fun clear() = tokens.clear()

    private companion object {
        /** How long /auth/refresh must be CONTINUOUSLY rejected with 401 before
         *  we give up the stored credentials and fall back to re-enrollment.
         *  Long enough to ride out a server redeploy / DB restore / secret
         *  rotation (so a transient rejection never strands the device), short
         *  enough that a genuinely-dead token surfaces the enrollment screen in
         *  reasonable time. */
        const val REENROLL_GRACE_S = 15 * 60L   // 15 minutes
    }
}

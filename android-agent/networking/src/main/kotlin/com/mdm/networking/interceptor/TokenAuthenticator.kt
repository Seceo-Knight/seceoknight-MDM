package com.mdm.networking.interceptor

import com.mdm.networking.auth.AuthRepository
import kotlinx.coroutines.runBlocking
import okhttp3.Authenticator
import okhttp3.Request
import okhttp3.Response
import okhttp3.Route

/**
 * OkHttp authenticator hook fired when the server returns 401. We attempt
 * exactly one refresh and replay; if that fails or the request has already
 * been replayed, we give up and let the 401 bubble to the caller.
 *
 * Coexists with [TokenInterceptor]: the interceptor handles proactive refresh
 * before the call goes out; the authenticator handles reactive refresh for the
 * narrow window between "token still valid by clock" and "server rejects it"
 * (e.g. JWT key rotation).
 */
class TokenAuthenticator(
    private val auth: AuthRepository
) : Authenticator {

    override fun authenticate(route: Route?, response: Response): Request? {
        if (responseCount(response) >= 2) return null  // already retried
        // CRITICAL: never react to a 401 on the refresh/enroll endpoints
        // themselves. They are unauthenticated entry points — there is nothing
        // to "refresh" in response to them — and re-entering refreshNow() here
        // DEADLOCKS the agent: refreshNow() holds a single-flight Mutex while it
        // awaits the /auth/refresh call; if that call 401s, OkHttp invokes this
        // authenticator on the call thread, which would runBlocking{ refreshNow() }
        // and block forever trying to re-acquire that same Mutex (it can't be
        // released until the call returns, but the call can't return until this
        // authenticator does). That hang is the "stuck Disconnected after a long
        // outage / server DB reset" bug — a refresh 401 froze the heartbeat loop.
        // Let the 401 bubble so refreshNow() can handle it (and so the heartbeat
        // loop records a failure and keeps fast-retrying).
        if (isAuthEntryPoint(response.request)) return null
        val newToken = runBlocking { auth.refreshNow() } ?: return null
        return response.request.newBuilder()
            .header("Authorization", "Bearer $newToken")
            .build()
    }

    /** Mirrors [TokenInterceptor.isUnauthRoute] — the routes the server treats
     *  as unauthenticated and that must never trigger a reactive refresh. */
    private fun isAuthEntryPoint(req: Request): Boolean {
        val path = req.url.encodedPath
        return path.endsWith("/api/v1/auth/refresh")
            || path == "/api/v1/enroll" || path == "/api/v1/enroll/"
    }

    private fun responseCount(response: Response): Int {
        var n = 1
        var r = response.priorResponse
        while (r != null) { n++; r = r.priorResponse }
        return n
    }
}

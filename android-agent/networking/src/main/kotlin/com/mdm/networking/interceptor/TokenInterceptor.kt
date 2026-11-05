package com.mdm.networking.interceptor

import com.mdm.networking.auth.AuthRepository
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.Request
import okhttp3.Response

/**
 * Adds `Authorization: Bearer <token>` to every request except enroll/refresh,
 * which the server treats as unauthenticated entry points.
 *
 * Refresh-on-expiry happens here proactively. Refresh-on-401 happens in
 * [TokenAuthenticator] which OkHttp wires into the retry path.
 */
class TokenInterceptor(
    private val auth: AuthRepository
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        if (isUnauthRoute(req) || isPresignedDownload(req)) return chain.proceed(req)

        val token = runBlocking { auth.ensureAccessToken() }
        val newReq: Request = if (token.isNullOrEmpty()) req
        else req.newBuilder().header("Authorization", "Bearer $token").build()
        return chain.proceed(newReq)
    }

    private fun isUnauthRoute(req: Request): Boolean {
        val path = req.url.encodedPath
        return path == "/api/v1/enroll/" || path == "/api/v1/enroll"
            || path.endsWith("/api/v1/auth/refresh")
    }

    // S3/MinIO presigned URLs already carry SigV4 authentication in the query
    // string (X-Amz-Algorithm + X-Amz-Signature). If we also slap our own
    // Authorization: Bearer header on the request, MinIO rejects it with
    // 400 "request has multiple authentication types". Detect presigned
    // requests by their tell-tale query param and let them through bare.
    private fun isPresignedDownload(req: Request): Boolean =
        req.url.queryParameter("X-Amz-Signature") != null
            || req.url.queryParameter("X-Amz-Algorithm") != null
}

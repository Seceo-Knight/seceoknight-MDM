package com.mdm.networking.di

import com.mdm.networking.BuildConfig
import com.mdm.networking.api.MdmApi
import com.mdm.networking.auth.AuthRepository
import com.mdm.networking.auth.TokenStore
import com.mdm.networking.interceptor.TokenAuthenticator
import com.mdm.networking.interceptor.TokenInterceptor
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import java.util.concurrent.TimeUnit
import javax.inject.Named
import javax.inject.Singleton

/**
 * Wires up everything the agent needs to talk HTTP / MQTT to the MDM server.
 *
 * Base URL resolution order (first non-null wins):
 *   1. [TokenStore.serverUrl] — set during enrollment
 *   2. BuildConfig.DEFAULT_SERVER_URL — compiled-in fallback
 *
 * We use a custom HttpUrl interceptor for (1) so the same Retrofit instance
 * can survive a re-enrollment without a process restart.
 */
@Module
@InstallIn(SingletonComponent::class)
object NetworkingModule {

    @Provides @Singleton
    fun provideMoshi(): Moshi = Moshi.Builder()
        .add(KotlinJsonAdapterFactory())
        .build()

    // AuthRepository is @Inject constructor — Hilt builds it directly. We
    // intentionally do NOT declare a @Provides for it here, because that
    // would create a duplicate binding.

    @Provides @Singleton
    fun provideOkHttp(
        auth: AuthRepository,
        tokens: TokenStore
    ): OkHttpClient {
        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BODY
                    else HttpLoggingInterceptor.Level.NONE
        }
        return OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            // Hard ceiling on the WHOLE call (DNS→connect→write→server→read,
            // incl. time spent in the auth interceptor/authenticator). Safely
            // above the 20s long-poll, this guarantees no request can ever wedge
            // the heartbeat/poll loop indefinitely — a defensive backstop so a
            // future hang surfaces as a retryable timeout instead of a freeze.
            .callTimeout(60, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .addInterceptor(BaseUrlInterceptor(tokens))
            .addInterceptor(TokenInterceptor(auth))
            .authenticator(TokenAuthenticator(auth))
            .addInterceptor(logging)
            .build()
    }

    /**
     * A bare client for downloading APKs/files from ABSOLUTE urls (GitHub release
     * assets, presigned MinIO/`/mdm-files/` links). It deliberately has NEITHER
     * [BaseUrlInterceptor] (which would rewrite the url's host/scheme/port to the
     * configured server — wrong for an off-host GitHub url, and signature-breaking
     * for a presigned url) NOR [TokenInterceptor] (a stray Authorization header
     * breaks presigned SigV4 auth). Use this — not the API client — to fetch bytes
     * from a url the server handed us. The agent self-update depends on it.
     */
    @Provides @Singleton @Named("download")
    fun provideDownloadOkHttp(): OkHttpClient =
        OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()

    @Provides @Singleton
    fun provideRetrofit(client: OkHttpClient, moshi: Moshi): Retrofit =
        Retrofit.Builder()
            .baseUrl(BuildConfig.DEFAULT_SERVER_URL.trimEnd('/') + "/")
            .client(client)
            .addConverterFactory(MoshiConverterFactory.create(moshi))
            .build()

    @Provides @Singleton
    fun provideApi(retrofit: Retrofit): MdmApi = retrofit.create(MdmApi::class.java)
}

/**
 * Swaps the request's host with [TokenStore.serverUrl] if set, so we can
 * compile the APK once and let enrollment point it at any environment.
 */
private class BaseUrlInterceptor(
    private val tokens: TokenStore
) : okhttp3.Interceptor {
    override fun intercept(chain: okhttp3.Interceptor.Chain): okhttp3.Response {
        val configured = tokens.serverUrl()
        if (configured.isNullOrBlank()) return chain.proceed(chain.request())
        // Coerce a missing scheme to http:// so a legacy/bare stored value
        // ("10.0.0.5:8080") still routes to the configured host instead of
        // silently falling back to the compiled-in default (mdm.example.com),
        // which would send every request to a dead host with no obvious cause.
        val normalized = configured.trimEnd('/').let {
            if (it.startsWith("http://") || it.startsWith("https://")) it else "http://$it"
        }
        val configuredHttp = runCatching {
            normalized.toHttpUrl()
        }.getOrElse { return chain.proceed(chain.request()) }
        val origin = chain.request().url
        val patched = origin.newBuilder()
            .scheme(configuredHttp.scheme)
            .host(configuredHttp.host)
            .port(configuredHttp.port)
            .build()
        return chain.proceed(chain.request().newBuilder().url(patched).build())
    }
}

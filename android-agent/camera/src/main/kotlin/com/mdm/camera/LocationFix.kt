package com.mdm.camera

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Looper
import androidx.core.content.ContextCompat
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import com.google.android.gms.tasks.Task
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume

/**
 * Single-fix location helper used by asset-recovery (photo + GPS), the
 * GET_LOCATION command and the heartbeat's last-known-location field.
 *
 * Provider strategy — fused FIRST, raw LocationManager as fallback:
 *
 *  1. [FusedLocationProviderClient] (Google Play Services). This is the only
 *     thing that reliably returns a fix on OEM ROMs such as OnePlus/Oppo
 *     (ColorOS) and Xiaomi (MIUI): those vendors funnel all location through
 *     the fused engine, leave `LocationManager.getLastKnownLocation` null, and
 *     a bare `GPS_PROVIDER` single-update never converges indoors. Fused fuses
 *     GPS + Wi-Fi + cell + sensors and answers in a second or two.
 *  2. Raw [LocationManager] fallback for the rare device with no Play Services
 *     (GMS-less ROM / de-Googled phone). Tries GPS, then network, then passive.
 *
 * Returns null only when permission is missing or every provider is exhausted.
 */
@Singleton
class LocationFix @Inject constructor(
    @ApplicationContext private val context: Context
) {

    data class Snapshot(
        val latitude: Double, val longitude: Double, val accuracyM: Float,
        val provider: String, val timestamp: Long, val isFresh: Boolean
    )

    private val lm: LocationManager? =
        context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager

    suspend fun get(timeoutMs: Long = 8_000L): Snapshot? {
        if (!hasPermission()) {
            Timber.w("LocationFix: ACCESS_*_LOCATION not granted")
            return null
        }
        // 1) Fused (Play Services) — the reliable cross-OEM path.
        fusedFix(timeoutMs)?.let { return it }
        // 2) Raw LocationManager fallback (GMS-less devices).
        return legacyFix(timeoutMs)
    }

    // ---------------------------------------------------------------- fused

    @SuppressLint("MissingPermission")
    private suspend fun fusedFix(timeoutMs: Long): Snapshot? = runCatching {
        val client = LocationServices.getFusedLocationProviderClient(context)

        // Instant: a recent cached fix the fused engine already holds.
        val last = withTimeoutOrNull(2_000L) { awaitTask(client.lastLocation) }

        // Active: compute a fresh fix. setMaxUpdateAgeMillis lets it short-
        // circuit to a very recent cached fix; setDurationMillis bounds how
        // long the engine will work before giving up.
        val request = CurrentLocationRequest.Builder()
            .setPriority(Priority.PRIORITY_HIGH_ACCURACY)
            .setMaxUpdateAgeMillis(10_000L)
            .setDurationMillis(timeoutMs)
            .build()
        val cts = CancellationTokenSource()
        val fresh = try {
            withTimeoutOrNull(timeoutMs + 1_000L) {
                awaitTask(client.getCurrentLocation(request, cts.token))
            }
        } finally {
            runCatching { cts.cancel() }
        }

        val pick = fresh ?: last ?: return@runCatching null
        Snapshot(
            latitude  = pick.latitude,
            longitude = pick.longitude,
            accuracyM = pick.accuracy,
            provider  = pick.provider ?: "fused",
            timestamp = pick.time,
            isFresh   = fresh != null
        )
    }.onFailure { Timber.w(it, "fused location unavailable — falling back to LocationManager") }
        .getOrNull()

    /** Bridges a GMS [Task] to a coroutine; resumes null on failure instead of throwing. */
    private suspend fun <T> awaitTask(task: Task<T>): T? =
        suspendCancellableCoroutine { cont ->
            task.addOnSuccessListener { if (cont.isActive) cont.resume(it) }
                .addOnFailureListener { if (cont.isActive) cont.resume(null) }
                .addOnCanceledListener { if (cont.isActive) cont.resume(null) }
        }

    // -------------------------------------------------------------- legacy

    @SuppressLint("MissingPermission")
    private suspend fun legacyFix(timeoutMs: Long): Snapshot? {
        val mgr = lm ?: return null
        val providers = listOf(
            LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER,
            LocationManager.PASSIVE_PROVIDER
        ).filter { runCatching { mgr.isProviderEnabled(it) }.getOrDefault(false) }

        val lastKnown: Location? = providers
            .mapNotNull { runCatching { mgr.getLastKnownLocation(it) }.getOrNull() }
            .maxByOrNull { it.time }

        // Listen on EVERY active provider at once and take whichever fixes
        // first — a fast network/wifi fix if the OEM has it, otherwise the GPS
        // fix once it locks. This beats the old single-provider request that
        // timed out waiting on a cold GPS alone.
        val active = providers.filter { it != LocationManager.PASSIVE_PROVIDER }
        val fresh = if (active.isEmpty()) null else withTimeoutOrNull(timeoutMs) {
            val def = CompletableDeferred<Location?>()
            val listeners = mutableListOf<android.location.LocationListener>()
            for (p in active) {
                val l = android.location.LocationListener { loc -> def.complete(loc) }
                listeners.add(l)
                runCatching {
                    mgr.requestLocationUpdates(p, 1_000L, 0f, l, Looper.getMainLooper())
                }.onFailure { Timber.w(it, "requestLocationUpdates($p)") }
            }
            try { def.await() } finally { listeners.forEach { runCatching { mgr.removeUpdates(it) } } }
        }

        val pick = fresh ?: lastKnown ?: return null
        return Snapshot(
            latitude  = pick.latitude,
            longitude = pick.longitude,
            accuracyM = pick.accuracy,
            provider  = pick.provider ?: "?",
            timestamp = pick.time,
            isFresh   = fresh != null
        )
    }

    private fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
}

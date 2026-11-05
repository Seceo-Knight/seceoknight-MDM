package com.mdm.command

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import timber.log.Timber
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Records the device microphone as a series of short back-to-back segments and
 * hands each finished segment to an upload callback. Device side of the
 * "near-live" listen feature — segments are ordinary `.m4a` (AAC) objects the
 * admin UI plays in sequence.
 *
 * Observability: [start] is suspending and AWAITS the first segment, returning
 * null on success or a human-readable reason on failure. This matters because
 * audio recording can fail silently — missing RECORD_AUDIO, the mic being held
 * by another app, or (Android 14) the hosting foreground service lacking the
 * `microphone` FGS type. Reporting the reason up the command result lets the
 * server/admin see *why* a capture produced nothing instead of a silent no-op.
 *
 * Requires RECORD_AUDIO (auto-granted in Device Owner mode; granted via the
 * in-app Permissions panel in Device Admin / enrolled-only mode) and the
 * hosting foreground service to declare the `microphone` type on Android 14+.
 */
@Singleton
class AudioStreamManager @Inject constructor(
    @ApplicationContext private val context: Context
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile private var activeSession: String? = null
    private var job: Job? = null

    fun isActive(session: String? = null): Boolean =
        activeSession != null && (session == null || activeSession == session)

    private fun hasMicPermission(): Boolean =
        context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /**
     * Begins a segmented recording session. Suspends until the first segment is
     * recorded (or fails), then returns: null = recording started successfully,
     * non-null = failure reason. The loop continues in the background for the
     * remaining segments. Only one session runs at a time.
     */
    suspend fun start(
        session: String,
        segmentSec: Int,
        maxSec: Int,
        upload: suspend (bytes: ByteArray, seq: Int) -> Unit
    ): String? {
        stop(null)
        if (!hasMicPermission()) {
            return "microphone permission (RECORD_AUDIO) not granted — grant it in the agent's Permissions panel"
        }
        activeSession = session
        val segMs = segmentSec.coerceIn(2, 30) * 1000L
        val maxMs = maxSec.coerceIn(segmentSec, 3600) * 1000L
        Timber.i("audio session $session start (segment=${segMs}ms max=${maxMs}ms)")

        val firstOutcome = CompletableDeferred<String?>()
        job = scope.launch {
            val startedAt = System.currentTimeMillis()
            var seq = 0
            try {
                while (isActive && activeSession == session &&
                    System.currentTimeMillis() - startedAt < maxMs) {
                    val file = File(context.cacheDir, "aud_${session}_$seq.aac")
                    val err = recordSegment(file, segMs)
                    if (err != null) {
                        if (!firstOutcome.isCompleted) firstOutcome.complete(err)
                        Timber.w("audio session $session: segment $seq failed: $err")
                        runCatching { file.delete() }
                        break
                    }
                    val bytes = runCatching { file.readBytes() }.getOrNull()
                    runCatching { file.delete() }
                    if (bytes != null && bytes.isNotEmpty()) {
                        val upErr = runCatching { upload(bytes, seq) }.exceptionOrNull()
                        if (upErr != null) {
                            Timber.w(upErr, "audio segment upload failed seq=$seq")
                            // First segment recorded fine but couldn't be sent —
                            // report it (with the recorded size, proving the mic
                            // worked) so the failure is the upload, not capture.
                            if (!firstOutcome.isCompleted) {
                                firstOutcome.complete("recorded ${bytes.size} bytes but upload failed: ${upErr.message}")
                                break
                            }
                            // Later segment: transient — skip it, keep streaming.
                        } else {
                            if (!firstOutcome.isCompleted) firstOutcome.complete(null)
                            seq++
                        }
                    } else {
                        if (!firstOutcome.isCompleted) firstOutcome.complete("recorded an empty segment")
                        break
                    }
                }
            } finally {
                if (!firstOutcome.isCompleted) {
                    firstOutcome.complete(if (seq > 0) null else "no audio captured")
                }
                if (activeSession == session) activeSession = null
                Timber.i("audio session $session ended after $seq segment(s)")
            }
        }
        // Wait for the first segment so the command result reflects reality. If
        // it's unusually slow, treat as started (the loop keeps going).
        return withTimeoutOrNull(segMs + 6000L) { firstOutcome.await() }
    }

    /** Stops [session], or any active session when [session] is null. */
    fun stop(session: String?) {
        if (session != null && activeSession != session) return
        activeSession = null
        job?.cancel()
        job = null
    }

    /**
     * Records one segment to [file] for [durationMs]. Returns null on success or
     * a failure reason. Cancellation (from [stop]) propagates.
     */
    private suspend fun recordSegment(file: File, durationMs: Long): String? {
        val recorder = newRecorder() ?: return "MediaRecorder unavailable"
        var started = false
        try {
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            // AAC inside a raw ADTS stream (not an MP4 container): consecutive
            // ADTS segments concatenate by simple byte-append, letting the
            // server stitch a whole session into one continuous .aac with no
            // transcoder. Keep the sample rate/bitrate identical across segments
            // so the concatenated stream has a consistent profile.
            recorder.setOutputFormat(MediaRecorder.OutputFormat.AAC_ADTS)
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            recorder.setAudioSamplingRate(44_100)
            recorder.setAudioEncodingBitRate(96_000)
            recorder.setOutputFile(file.absolutePath)
            recorder.prepare()
            recorder.start()
            started = true
            delay(durationMs)
            return null
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            Timber.w(t, "recordSegment failed")
            // If start() succeeded, a stop()-time error still leaves a usable
            // file, so treat that as success; otherwise report the reason.
            return if (started) null else (t.message ?: t::class.java.simpleName)
        } finally {
            if (started) runCatching { recorder.stop() }
            runCatching { recorder.release() }
        }
    }

    @Suppress("DEPRECATION")
    private fun newRecorder(): MediaRecorder? = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else MediaRecorder()
    }.getOrNull()
}

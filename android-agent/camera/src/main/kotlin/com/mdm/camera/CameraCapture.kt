package com.mdm.camera

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Size
import androidx.core.content.ContextCompat
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

/**
 * Headless single-frame JPEG capture via Camera2. No preview surface; the
 * device's privacy indicator dot will still appear briefly on Android 12+,
 * which is the expected behaviour for fleet asset-recovery features.
 *
 * In Device Owner mode the caller is expected to pre-grant
 * android.permission.CAMERA via DPM.setPermissionGrantState; otherwise the
 * capture fails fast with [SecurityException].
 *
 * Flow:
 *   1. Pick a camera by lens facing (back default).
 *   2. Pick the largest JPEG resolution it advertises (capped to 1080p to
 *      keep result payload sane).
 *   3. Open the device, build a one-shot capture session against an
 *      ImageReader, fire CAPTURE_TEMPLATE_STILL_CAPTURE, await the image.
 *   4. Close everything; return the JPEG bytes.
 *
 * Errors are mapped to [CameraResult.Error] with a short reason — the
 * CommandExecutor surfaces these to the admin via `last_error`.
 */
@Singleton
class CameraCapture @Inject constructor(
    @ApplicationContext private val context: Context
) {

    enum class Lens { BACK, FRONT }

    sealed class CameraResult {
        data class Success(val jpeg: ByteArray, val widthPx: Int, val heightPx: Int) : CameraResult()
        data class Error(val reason: String) : CameraResult()
    }

    private val manager: CameraManager =
        context.getSystemService(Context.CAMERA_SERVICE) as CameraManager

    suspend fun capture(lens: Lens = Lens.BACK, useFlash: Boolean = false): CameraResult {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED) {
            return CameraResult.Error(
                "CAMERA permission not granted (grant via DPM or settings)"
            )
        }

        val cameraId = pickCamera(lens) ?: return CameraResult.Error("no camera matches lens=$lens")

        val charac = manager.getCameraCharacteristics(cameraId)
        val map = charac.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            ?: return CameraResult.Error("no stream config map")
        val size = pickJpegSize(map.getOutputSizes(ImageFormat.JPEG))
            ?: return CameraResult.Error("no JPEG sizes")
        // Small preview-format reader purely to give the sensor a surface for
        // a repeating preview request — needed so autofocus and auto-exposure
        // converge before the still capture fires. Frames are drained and
        // closed immediately; the bytes are not used.
        val previewSize = pickPreviewSize(map.getOutputSizes(ImageFormat.YUV_420_888))
            ?: Size(640, 480)

        val backThread = HandlerThread("mdm-cam").also { it.start() }
        val handler = Handler(backThread.looper)
        val reader = ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 1)
        val previewReader = ImageReader.newInstance(
            previewSize.width, previewSize.height, ImageFormat.YUV_420_888, 2
        )
        previewReader.setOnImageAvailableListener({ r ->
            // Just drain — we only need the frames so 3A can run.
            runCatching { r.acquireLatestImage()?.close() }
        }, handler)

        val imageDeferred = CompletableDeferred<ByteArray?>()
        reader.setOnImageAvailableListener({ r ->
            val img = r.acquireNextImage()
            try {
                if (img == null) {
                    imageDeferred.complete(null)
                    return@setOnImageAvailableListener
                }
                val buf = img.planes[0].buffer
                val bytes = ByteArray(buf.remaining())
                buf.get(bytes)
                imageDeferred.complete(bytes)
            } finally {
                img?.close()
            }
        }, handler)

        var device: CameraDevice? = null
        var session: CameraCaptureSession? = null
        try {
            device = openCamera(cameraId, handler)
            session = createSession(device, listOf(previewReader.surface, reader.surface), handler)

            // 1) Repeating preview — gives the sensor frames to warm up on. We
            //    use CONTINUOUS_PICTURE so autofocus runs without us pumping
            //    AF triggers; AE/AWB run on AUTO. This is the canonical pattern
            //    for headless still capture on Camera2.
            val previewReq = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                addTarget(previewReader.surface)
                set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                set(CaptureRequest.CONTROL_AE_MODE,
                    if (useFlash) CaptureRequest.CONTROL_AE_MODE_ON_ALWAYS_FLASH
                    else CaptureRequest.CONTROL_AE_MODE_ON)
                set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_AUTO)
            }.build()
            session.setRepeatingRequest(previewReq, null, handler)

            // 2) Trigger one-shot autofocus, then wait for AF_STATE to settle.
            val afLockReq = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                addTarget(previewReader.surface)
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_START)
            }.build()
            awaitState(session, afLockReq, handler, AF_TIMEOUT_MS) { r ->
                val st = r.get(CaptureResult.CONTROL_AF_STATE) ?: return@awaitState true
                st == CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED
                    || st == CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED
                    || st == CaptureResult.CONTROL_AF_STATE_PASSIVE_FOCUSED
                    || st == CaptureResult.CONTROL_AF_STATE_PASSIVE_UNFOCUSED
            }

            // 3) AE precapture — triggers metering for the actual still. Skip
            //    if AE is already CONVERGED on the preview stream (typical when
            //    lighting is steady).
            val aePrecaptureReq = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                addTarget(previewReader.surface)
                set(CaptureRequest.CONTROL_AE_MODE,
                    if (useFlash) CaptureRequest.CONTROL_AE_MODE_ON_ALWAYS_FLASH
                    else CaptureRequest.CONTROL_AE_MODE_ON)
                set(CaptureRequest.CONTROL_AE_PRECAPTURE_TRIGGER,
                    CaptureRequest.CONTROL_AE_PRECAPTURE_TRIGGER_START)
            }.build()
            awaitState(session, aePrecaptureReq, handler, AE_TIMEOUT_MS) { r ->
                val st = r.get(CaptureResult.CONTROL_AE_STATE) ?: return@awaitState true
                st == CaptureResult.CONTROL_AE_STATE_CONVERGED
                    || st == CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED
                    || st == CaptureResult.CONTROL_AE_STATE_LOCKED
            }

            // 4) Stop the preview and fire the still. JPEG_ORIENTATION reads
            //    the sensor orientation so the image lands rightside-up.
            session.stopRepeating()
            val sensorOrientation =
                charac.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
            val stillReq = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
                addTarget(reader.surface)
                set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                set(CaptureRequest.CONTROL_AE_MODE,
                    if (useFlash) CaptureRequest.CONTROL_AE_MODE_ON_ALWAYS_FLASH
                    else CaptureRequest.CONTROL_AE_MODE_ON)
                set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_AUTO)
                set(CaptureRequest.JPEG_QUALITY, 92.toByte())
                set(CaptureRequest.JPEG_ORIENTATION, sensorOrientation)
            }.build()
            session.capture(stillReq, object : CameraCaptureSession.CaptureCallback() {}, handler)

            val bytes = imageDeferred.await()
                ?: return CameraResult.Error("image listener returned null")
            return CameraResult.Success(bytes, size.width, size.height)
        } catch (sec: SecurityException) {
            Timber.w(sec, "camera capture denied")
            return CameraResult.Error("permission denied: ${sec.message}")
        } catch (t: Throwable) {
            Timber.e(t, "camera capture failed")
            return CameraResult.Error(t.message ?: t::class.java.simpleName)
        } finally {
            runCatching { session?.close() }
            runCatching { device?.close() }
            reader.close()
            previewReader.close()
            backThread.quitSafely()
        }
    }

    /**
     * Fires [trigger] on the session, then watches each TotalCaptureResult
     * until [done] returns true (state converged) or the timeout fires. If
     * the timeout fires we just continue — typical when the sensor is on a
     * very stable surface and 3A is already converged but reports as
     * INACTIVE. Better to capture something slightly off than to fail.
     */
    private suspend fun awaitState(
        session: CameraCaptureSession,
        trigger: CaptureRequest,
        handler: Handler,
        timeoutMs: Long,
        done: (CaptureResult) -> Boolean
    ) {
        val gate = CompletableDeferred<Unit>()
        val cb = object : CameraCaptureSession.CaptureCallback() {
            override fun onCaptureCompleted(
                s: CameraCaptureSession, r: CaptureRequest, res: TotalCaptureResult
            ) {
                if (!gate.isCompleted && done(res)) gate.complete(Unit)
            }
        }
        session.capture(trigger, cb, handler)
        withTimeoutOrNull(timeoutMs) { gate.await() }
            ?: Timber.w("3A state did not converge within ${timeoutMs}ms — proceeding anyway")
    }

    fun setTorch(on: Boolean): Boolean {
        val id = pickCamera(Lens.BACK) ?: return false
        return try {
            manager.setTorchMode(id, on)
            true
        } catch (t: Throwable) {
            Timber.w(t, "setTorch failed")
            false
        }
    }

    private fun pickCamera(lens: Lens): String? {
        val want = when (lens) {
            Lens.BACK  -> CameraCharacteristics.LENS_FACING_BACK
            Lens.FRONT -> CameraCharacteristics.LENS_FACING_FRONT
        }
        return manager.cameraIdList.firstOrNull { id ->
            manager.getCameraCharacteristics(id)
                .get(CameraCharacteristics.LENS_FACING) == want
        }
    }

    /** Largest JPEG ≤ 1920×1080 to keep request bodies under a few MB. */
    private fun pickJpegSize(sizes: Array<Size>?): Size? {
        if (sizes == null || sizes.isEmpty()) return null
        val MAX_W = 1920
        val MAX_H = 1080
        return sizes
            .filter { it.width <= MAX_W && it.height <= MAX_H }
            .maxByOrNull { it.width.toLong() * it.height }
            ?: sizes.minByOrNull { it.width.toLong() * it.height }
    }

    /** Smallest preview size ≥ 640×480 — preview is just a 3A heartbeat, not output. */
    private fun pickPreviewSize(sizes: Array<Size>?): Size? {
        if (sizes == null || sizes.isEmpty()) return null
        return sizes
            .filter { it.width >= 640 && it.width <= 1280 }
            .minByOrNull { it.width.toLong() * it.height }
            ?: sizes.minByOrNull { it.width.toLong() * it.height }
    }

    @SuppressLint("MissingPermission")
    private suspend fun openCamera(id: String, h: Handler): CameraDevice =
        suspendCoroutine { cont ->
            manager.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(camera: CameraDevice) = cont.resume(camera)
                override fun onDisconnected(camera: CameraDevice) {
                    camera.close()
                    cont.resumeWithException(RuntimeException("camera disconnected"))
                }
                override fun onError(camera: CameraDevice, error: Int) {
                    camera.close()
                    cont.resumeWithException(RuntimeException("camera open error $error"))
                }
            }, h)
        }

    private companion object {
        // Generous on cheap phones — the back camera AF motor can be slow.
        const val AF_TIMEOUT_MS = 2500L
        const val AE_TIMEOUT_MS = 1500L
    }

    private suspend fun createSession(
        device: CameraDevice, outputs: List<android.view.Surface>, h: Handler
    ): CameraCaptureSession = suspendCoroutine { cont ->
        @Suppress("DEPRECATION")
        device.createCaptureSession(outputs, object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(session: CameraCaptureSession) = cont.resume(session)
            override fun onConfigureFailed(session: CameraCaptureSession) =
                cont.resumeWithException(RuntimeException("capture session config failed"))
        }, h)
    }
}

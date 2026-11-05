package com.mdm.command

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.os.PowerManager
import android.os.SystemClock
import com.mdm.networking.api.MdmApi
import com.mdm.networking.auth.AuthRepository
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import timber.log.Timber
import java.io.File
import java.util.concurrent.Executors
import javax.inject.Inject
import javax.inject.Singleton

private const val CAPTURE_FPS = 30
// Encoder-side latency levers (encoder only — never the capture/projection).
// scaleResolutionDownBy halves each dimension (¼ pixels) preserving aspect (no
// crop) and follows rotation; the bitrate cap keeps congestion control snappy.
private const val SCALE_DOWN_BY = 2.0
private const val MAX_BITRATE_BPS = 2_500_000

/**
 * Live screen mirror over WebRTC. On START_SCREEN_SHARE the agent (the OFFERER)
 * captures the screen via MediaProjection → ScreenCapturerAndroid, attaches it
 * as a sendonly video track to a PeerConnection, and negotiates with the watching
 * admin browser through the [SignalingClient] (/ws/signal relay). ICE servers
 * (STUN/TURN) are supplied by the server in the command payload so the headless
 * device doesn't need to call the admin-only TURN endpoint.
 *
 * Recording ("store what was done") is best-effort and isolated in
 * [ScreenRecorder]: it taps the same video track to an MP4 and uploads it to
 * file-service (kind="screen") on stop. A recorder failure never breaks the live
 * view.
 *
 * Single session, single viewer (Phase 1). All PeerConnection mutation runs on a
 * dedicated single-thread executor — WebRTC requires consistent threading.
 */
@Singleton
class WebRtcScreenShareManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val auth: AuthRepository,
    private val api: MdmApi,
) {
    private val exec = Executors.newSingleThreadExecutor()
    private val ioScope = CoroutineScope(Dispatchers.IO)

    private var eglBase: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var pc: PeerConnection? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var surfaceHelper: SurfaceTextureHelper? = null
    private var signaling: SignalingClient? = null
    private var dataChannel: DataChannel? = null
    private var recorder: ScreenRecorder? = null
    private var wakeLock: PowerManager.WakeLock? = null
    @Volatile private var session: String? = null

    // Lifecycle breadcrumb for remote diagnosis (uploaded as kind="screendiag" on
    // stop). Tells us WHY a session ends — e.g. the system stopping the projection
    // vs. an offer failure — without needing adb/logcat on the device.
    private val diag = StringBuilder()
    @Volatile private var t0 = 0L
    private fun diag(m: String) {
        synchronized(diag) { diag.append("+").append(SystemClock.elapsedRealtime() - t0).append("ms ").append(m).append(" | ") }
        Timber.i("screendiag: $m")
    }

    fun isActive(): Boolean = session != null

    /**
     * @param resultCode/data the MediaProjection consent result (from ProjectionRequestActivity)
     * @param iceServersJson  JSON array of {urls,[username,credential]} from the command payload
     * @param record          whether to record the session to MP4 + upload on stop
     */
    fun start(sessionId: String, resultCode: Int, data: Intent, iceServersJson: String?, record: Boolean) {
        exec.execute {
            try {
                if (session != null) stopInternal()
                session = sessionId
                t0 = SystemClock.elapsedRealtime()
                synchronized(diag) { diag.setLength(0) }
                // Keep the display on + wake it: MediaProjection only captures a
                // rendering screen, so without this a session started while the phone
                // is asleep shows black / hangs on "waiting for device".
                runCatching {
                    val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
                    @Suppress("DEPRECATION")
                    wakeLock = pm.newWakeLock(
                        PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                        "mdm:screenshare"
                    ).apply { setReferenceCounted(false); acquire(60 * 60 * 1000L) }
                }.onFailure { Timber.w(it, "screen: wakelock failed") }
                ensureFactory()
                diag("factory ready")
                val egl = eglBase ?: return@execute
                val f = factory ?: return@execute

                capturer = ScreenCapturerAndroid(data, object : MediaProjection.Callback() {
                    override fun onStop() {
                        diag("MediaProjection.onStop (system stopped capture)")
                        Timber.i("screen: projection stopped by system"); stop(sessionId)
                    }
                })
                surfaceHelper = SurfaceTextureHelper.create("screen-cap", egl.eglBaseContext)
                videoSource = f.createVideoSource(/* isScreencast = */ true)
                capturer!!.initialize(surfaceHelper, context, videoSource!!.capturerObserver)
                val metrics = context.resources.displayMetrics
                // Capture at the device's native resolution. Downscaling the capture
                // here (a smaller VirtualDisplay) tears the encoder/projection down on
                // this OEM, so we keep full res and reduce latency on the browser side
                // (zero jitter buffer) instead. ScreenCapturerAndroid tracks rotation,
                // so the frame dimensions flip on landscape — the UI adapts to that.
                capturer!!.startCapture(metrics.widthPixels, metrics.heightPixels, CAPTURE_FPS)
                diag("startCapture ${metrics.widthPixels}x${metrics.heightPixels}")
                videoTrack = f.createVideoTrack("screen0", videoSource).apply { setEnabled(true) }

                pc = f.createPeerConnection(rtcConfig(iceServersJson), pcObserver()) ?: run {
                    Timber.w("screen: createPeerConnection null"); stopInternal(); return@execute
                }
                val videoSender = pc!!.addTrack(videoTrack, listOf("screenstream"))
                diag("pc+track ready")

                // Phase 2 control channel: the offerer creates it so its m-line is in
                // the offer. The browser receives it via ondatachannel and sends input
                // (tap/swipe/key/text) which we inject through the accessibility service.
                // Harmless in view-only mode — the browser simply never sends anything.
                dataChannel = pc!!.createDataChannel("control", DataChannel.Init().apply { ordered = true })
                    .also { it.registerObserver(controlObserver(it)) }
                diag("control channel ready")

                // Latency lever: tell the ENCODER to output at half resolution and cap
                // bitrate/fps. scaleResolutionDownBy halves each dimension (¼ the pixels
                // → far less to encode/transmit) while PRESERVING aspect ratio (no crop)
                // and following rotation automatically. This only touches the encoder,
                // never the capture/VirtualDisplay, so it can't tear the projection down.
                runCatching {
                    val p = videoSender.parameters
                    if (p.encodings.isNotEmpty()) {
                        p.encodings.forEach { enc ->
                            enc.scaleResolutionDownBy = SCALE_DOWN_BY
                            enc.maxBitrateBps = MAX_BITRATE_BPS
                            enc.maxFramerate = CAPTURE_FPS
                        }
                        videoSender.parameters = p
                        diag("encoder scaled /$SCALE_DOWN_BY")
                    } else diag("no encodings to scale")
                }.onFailure { diag("scale params failed: ${it.message}") }

                // Best-effort recording — never let it sink the live stream.
                if (record) {
                    recorder = runCatching {
                        ScreenRecorder(egl, metrics.widthPixels, metrics.heightPixels).also { r ->
                            r.start(); videoTrack!!.addSink(r.sink)
                        }
                    }.onFailure { Timber.w(it, "screen: recorder start failed (continuing live)") }.getOrNull()
                }

                signaling = SignalingClient(
                    wsUrl = signalUrl() ?: run { Timber.w("screen: no signal url"); stopInternal(); return@execute },
                    accessToken = auth.accessToken() ?: "",
                    onMessage = { msg -> exec.execute { onSignal(msg) } },
                    // If signaling drops, the session is dead (no reconnect in Phase 1):
                    // record the reason and tear down (which uploads the breadcrumb).
                    onClosed = { reason -> diag("signaling closed: $reason"); stop(sessionId) },
                ).also { it.connect() }
                diag("signaling.connect()")

                // Agent is the offerer: once signaling is up, send the offer.
                createOffer()
                diag("session started")
                Timber.i("screen: session $sessionId started (${metrics.widthPixels}x${metrics.heightPixels}, record=$record)")
            } catch (t: Throwable) {
                diag("start EXCEPTION: ${t.message ?: t::class.java.simpleName}")
                Timber.e(t, "screen: start failed")
                stopInternal()
            }
        }
    }

    fun stop(sessionId: String?) {
        exec.execute {
            if (sessionId != null && sessionId != session) return@execute
            stopInternal()
        }
    }

    // ---- internals (all on `exec`) ----

    private fun ensureFactory() {
        if (factory != null) return
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions()
        )
        val egl = EglBase.create().also { eglBase = it }
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
    }

    private fun rtcConfig(iceServersJson: String?): PeerConnection.RTCConfiguration {
        val servers = ArrayList<PeerConnection.IceServer>()
        runCatching {
            if (!iceServersJson.isNullOrBlank()) {
                val arr = JSONArray(iceServersJson)
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    val urls = o.getJSONArray("urls")
                    val b = PeerConnection.IceServer.builder((0 until urls.length()).map { urls.getString(it) })
                    if (o.has("username")) b.setUsername(o.getString("username"))
                    if (o.has("credential")) b.setPassword(o.getString("credential"))
                    servers.add(b.createIceServer())
                }
            }
        }.onFailure { Timber.w(it, "screen: bad ice servers") }
        if (servers.isEmpty()) servers.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer())
        return PeerConnection.RTCConfiguration(servers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
    }

    private fun createOffer() {
        val c = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"))
        }
        pc?.createOffer(object : SimpleSdp() {
            override fun onCreateSuccess(sdp: SessionDescription) {
                diag("offer created (${sdp.description.length}b)")
                pc?.setLocalDescription(SimpleSdp(), sdp)
                send(JSONObject().put("type", "offer").put("sdp", sdp.description))
                diag("offer sent")
            }
            override fun onCreateFailure(error: String?) { diag("offer FAILED: $error") }
        }, c)
    }

    private fun onSignal(msg: JSONObject) {
        when (msg.optString("type")) {
            "answer" -> pc?.setRemoteDescription(
                SimpleSdp(), SessionDescription(SessionDescription.Type.ANSWER, msg.getString("sdp"))
            )
            "ice" -> pc?.addIceCandidate(
                IceCandidate(msg.optString("sdpMid"), msg.optInt("sdpMLineIndex"), msg.getString("candidate"))
            )
        }
    }

    // ---- Phase 2: remote input over the control DataChannel ----

    private fun controlObserver(dc: DataChannel) = object : DataChannel.Observer {
        override fun onBufferedAmountChange(previousAmount: Long) {}
        override fun onStateChange() { diag("control channel ${dc.state()}") }
        override fun onMessage(buffer: DataChannel.Buffer) {
            val bytes = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
            handleControl(String(bytes, Charsets.UTF_8))
        }
    }

    /** Route a JSON input event from the browser to the accessibility service. */
    private fun handleControl(text: String) {
        val rc = RemoteControlService.instance ?: run { diag("control: no a11y service"); return }
        val o = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (o.optString("type")) {
            "tap" -> rc.injectTap(o.optDouble("x").toFloat(), o.optDouble("y").toFloat())
            "swipe" -> rc.injectSwipe(
                o.optDouble("x1").toFloat(), o.optDouble("y1").toFloat(),
                o.optDouble("x2").toFloat(), o.optDouble("y2").toFloat(),
                o.optLong("ms", 200L),
            )
            "key" -> rc.injectGlobal(o.optString("action"))
            "text" -> rc.injectText(o.optString("text"), o.optBoolean("backspace", false))
        }
    }

    private fun pcObserver() = object : MinimalPcObserver() {
        override fun onIceCandidate(c: IceCandidate) {
            send(JSONObject().put("type", "ice").put("candidate", c.sdp)
                .put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex))
        }
    }

    private fun send(o: JSONObject) = signaling?.send(o)

    private fun stopInternal() {
        val s = session
        session = null
        diag("stopInternal")
        val diagSnapshot = synchronized(diag) { diag.toString() }
        runCatching { wakeLock?.let { if (it.isHeld) it.release() } }; wakeLock = null
        runCatching { signaling?.close() }; signaling = null
        runCatching { dataChannel?.dispose() }; dataChannel = null
        runCatching { pc?.close() }; pc = null
        runCatching { capturer?.stopCapture() }
        runCatching { capturer?.dispose() }; capturer = null
        runCatching { videoTrack?.dispose() }; videoTrack = null
        runCatching { videoSource?.dispose() }; videoSource = null
        runCatching { surfaceHelper?.dispose() }; surfaceHelper = null
        // Finalize + upload the recording (best-effort, off the exec thread).
        val rec = recorder; recorder = null
        if (rec != null && s != null) {
            ioScope.launch {
                val mp4 = runCatching { rec.stopAndFinalize() }.getOrNull()
                if (mp4 != null && mp4.exists() && mp4.length() > 0) uploadRecording(s, mp4)
            }
        }
        // Always upload the lifecycle breadcrumb so we can diagnose why a session
        // ended (system onStop vs offer failure vs exception) without adb.
        if (s != null) ioScope.launch { uploadDiag(s, diagSnapshot) }
        Timber.i("screen: session ${s ?: "?"} stopped")
    }

    private suspend fun uploadDiag(sessionId: String, text: String) {
        runCatching {
            val name = "screendiag_${sessionId}_${System.currentTimeMillis()}.txt"
            val body = (if (text.isBlank()) "(empty)" else text).toRequestBody("text/plain".toMediaTypeOrNull())
            val part = MultipartBody.Part.createFormData("file", name, body)
            val kind = "screendiag".toRequestBody("text/plain".toMediaTypeOrNull())
            val nm = name.toRequestBody("text/plain".toMediaTypeOrNull())
            api.deviceUpload(part, kind, nm)
        }.onFailure { Timber.w(it, "screendiag upload failed") }
    }

    private suspend fun uploadRecording(sessionId: String, file: File) {
        runCatching {
            val name = "screen_${sessionId}_${System.currentTimeMillis()}.mp4"
            val part = MultipartBody.Part.createFormData("file", name, file.asRequestBody("video/mp4".toMediaTypeOrNull()))
            val kind = "screen".toRequestBody("text/plain".toMediaTypeOrNull())
            val nm = name.toRequestBody("text/plain".toMediaTypeOrNull())
            val resp = api.deviceUpload(part, kind, nm)
            if (resp.isSuccessful) Timber.i("screen: recording uploaded ($name, ${file.length()}b)")
            else Timber.w("screen: recording upload HTTP ${resp.code()}")
        }.onFailure { Timber.w(it, "screen: recording upload failed") }
        runCatching { file.delete() }
    }

    private fun signalUrl(): String? {
        val base = auth.serverUrl()?.trimEnd('/') ?: return null
        return base.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + "/ws/signal"
    }
}

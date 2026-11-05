package com.mdm.command

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.view.Surface
import org.webrtc.EglBase
import org.webrtc.EglRenderer
import org.webrtc.GlRectDrawer
import org.webrtc.VideoSink
import timber.log.Timber
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Best-effort screen-session recorder for the "store what was done" requirement.
 * It taps the WebRTC video track via [sink] (an EglRenderer is itself a VideoSink),
 * renders each frame onto a MediaCodec H.264 input Surface, and muxes the encoded
 * stream to an MP4. Fully independent of the live mirror — any failure here is
 * caught by [WebRtcScreenShareManager] and never affects streaming.
 */
class ScreenRecorder(private val egl: EglBase, width: Int, height: Int) {
    private val w = (width / 2) * 2   // H.264 wants even dimensions
    private val h = (height / 2) * 2
    private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    private val inputSurface: Surface
    private val renderer = EglRenderer("screen-rec")
    private val outFile: File = File.createTempFile("screenrec_", ".mp4")
    private val muxer = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    private var muxTrack = -1
    private val muxing = AtomicBoolean(false)
    private val stopped = AtomicBoolean(false)
    private var drainThread: Thread? = null

    /** EglRenderer implements VideoSink — attach it to the track to receive frames. */
    val sink: VideoSink get() = renderer

    init {
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, 4_000_000)
            setInteger(MediaFormat.KEY_FRAME_RATE, 30)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
        }
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        inputSurface = codec.createInputSurface()
    }

    fun start() {
        codec.start()
        renderer.init(egl.eglBaseContext, EglBase.CONFIG_RECORDABLE, GlRectDrawer())
        renderer.createEglSurface(inputSurface)
        drainThread = Thread({ drainLoop() }, "screen-rec-drain").apply { start() }
    }

    private fun drainLoop() {
        val info = MediaCodec.BufferInfo()
        try {
            while (true) {
                val idx = codec.dequeueOutputBuffer(info, 10_000)
                if (idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    muxTrack = muxer.addTrack(codec.outputFormat)
                    muxer.start(); muxing.set(true)
                } else if (idx >= 0) {
                    val buf = codec.getOutputBuffer(idx)
                    val isConfig = (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
                    if (buf != null && info.size > 0 && muxing.get() && !isConfig) {
                        buf.position(info.offset); buf.limit(info.offset + info.size)
                        muxer.writeSampleData(muxTrack, buf, info)
                    }
                    codec.releaseOutputBuffer(idx, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                } else if (idx == MediaCodec.INFO_TRY_AGAIN_LATER && stopped.get()) {
                    break
                }
            }
        } catch (t: Throwable) {
            Timber.w(t, "screen-rec: drain loop ended")
        }
    }

    /** Stops capture, flushes the encoder, finalizes the MP4 and returns it. */
    fun stopAndFinalize(): File {
        runCatching { renderer.release() }              // stop feeding frames to the input surface
        runCatching { codec.signalEndOfInputStream() }  // flush encoder → drain loop sees EOS
        runCatching { drainThread?.join(3000) }
        stopped.set(true)
        runCatching { drainThread?.join(500) }
        runCatching { codec.stop() }
        runCatching { codec.release() }
        runCatching { if (muxing.get()) muxer.stop() }
        runCatching { muxer.release() }
        return outFile
    }
}

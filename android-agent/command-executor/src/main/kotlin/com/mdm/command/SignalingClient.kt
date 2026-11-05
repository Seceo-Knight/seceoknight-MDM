package com.mdm.command

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import timber.log.Timber
import java.util.concurrent.TimeUnit

/**
 * WebSocket signaling client for the WebRTC screen-share feature. The agent (the
 * "device" side) connects to `/ws/signal` on the server, which relays SDP
 * offers/answers and ICE candidates to/from the admin browser (per-(tenant,
 * device) room — see notification-service `internal/signal`).
 *
 * Auth: the device access token is sent as the `Bearer <token>` WebSocket
 * subprotocol, matching the server handler (and how the browser authenticates).
 *
 * Transport only — it never interprets the JSON envelopes; the
 * [WebRtcScreenShareManager] owns the PeerConnection state machine.
 */
class SignalingClient(
    private val wsUrl: String,        // e.g. "wss://10.0.0.5:8080/ws/signal"
    private val accessToken: String,
    private val onMessage: (JSONObject) -> Unit,
    private val onClosed: (reason: String) -> Unit,
) {
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS) // keep the relay connection warm
        .build()
    @Volatile private var ws: WebSocket? = null

    fun connect() {
        val req = Request.Builder()
            .url(wsUrl)
            .addHeader("Sec-WebSocket-Protocol", "Bearer $accessToken")
            .build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Timber.i("signal: connected")
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching { onMessage(JSONObject(text)) }
                    .onFailure { Timber.w(it, "signal: bad message") }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Timber.w(t, "signal: ws failure")
                onClosed(t.message ?: "failure")
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Timber.i("signal: closed $code $reason")
                onClosed(reason)
            }
        })
    }

    /** Send a signaling envelope (e.g. {type:"offer"|"answer"|"ice", ...}). */
    fun send(msg: JSONObject) {
        ws?.send(msg.toString())
    }

    fun close() {
        ws?.close(1000, "done")
        ws = null
    }
}

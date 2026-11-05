package com.mdm.networking.mqtt

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended
import org.eclipse.paho.client.mqttv3.MqttClient
import org.eclipse.paho.client.mqttv3.MqttConnectOptions
import org.eclipse.paho.client.mqttv3.MqttMessage
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence
import timber.log.Timber
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Eclipse Paho client wrapper that exposes incoming command messages as a Flow.
 *
 * Reliability model:
 *  - clean session = false: server retains undelivered messages while offline;
 *  - automaticReconnect = true: Paho handles re-establishing the TCP connection;
 *  - keepAlive 30s: aggressive enough to detect dead links before our HTTP poll;
 *  - QoS 1 on subscribe: each command delivered at-least-once;
 *  - Bearer JWT passed as MQTT password so the broker can ACL-enforce per
 *    device via mosquitto-go-auth or similar.
 *
 * The Flow buffers messages in a Channel.BUFFERED — backpressure is fine
 * because [com.mdm.command.CommandExecutor] processes them serially.
 */
@Singleton
class MdmMqttClient @Inject constructor() {

    private var client: MqttClient? = null
    private val incoming = Channel<MqttPayload>(Channel.BUFFERED)
    private val connected = AtomicBoolean(false)
    // Last connect params, so kick() can re-establish after a network drop
    // without the caller having to re-supply them.
    @Volatile private var lastParams: Params? = null

    private data class Params(
        val broker: String, val clientId: String,
        val username: String, val password: String, val subscribeTopic: String
    )

    data class MqttPayload(val topic: String, val bytes: ByteArray) {
        override fun equals(other: Any?): Boolean =
            this === other || (other is MqttPayload && topic == other.topic && bytes.contentEquals(other.bytes))
        override fun hashCode(): Int = 31 * topic.hashCode() + bytes.contentHashCode()
    }

    fun messages(): Flow<MqttPayload> = incoming.receiveAsFlow()

    fun isConnected(): Boolean = connected.get()

    /**
     * @param broker  e.g. ssl://mqtt.example.com:8883 or tcp://… for dev
     * @param clientId stable, per-device; the server uses this for ACL keying
     * @param username device_id
     * @param password short-lived JWT
     * @param subscribeTopic e.g. mdm/<tenant>/devices/<deviceId>/cmd
     */
    @Synchronized
    fun connect(
        broker: String,
        clientId: String,
        username: String,
        password: String,
        subscribeTopic: String
    ) {
        lastParams = Params(broker, clientId, username, password, subscribeTopic)
        if (connected.get()) {
            Timber.d("MQTT already connected"); return
        }
        val c = MqttClient(broker, clientId, MemoryPersistence())
        val opts = MqttConnectOptions().apply {
            isCleanSession = false
            isAutomaticReconnect = true
            keepAliveInterval = 30
            connectionTimeout = 15
            this.userName = username
            this.password = password.toCharArray()
            mqttVersion = MqttConnectOptions.MQTT_VERSION_3_1_1
        }
        c.setCallback(object : MqttCallbackExtended {
            override fun connectComplete(reconnect: Boolean, serverURI: String?) {
                Timber.i("MQTT connected (reconnect=$reconnect) $serverURI")
                connected.set(true)
                runCatching { c.subscribe(subscribeTopic, 1) }
                    .onFailure { Timber.w(it, "MQTT subscribe failed") }
            }
            override fun connectionLost(cause: Throwable?) {
                Timber.w(cause, "MQTT connection lost"); connected.set(false)
            }
            override fun messageArrived(topic: String, msg: MqttMessage) {
                Timber.v("MQTT msg on $topic (${msg.payload.size}B)")
                incoming.trySend(MqttPayload(topic, msg.payload))
            }
            override fun deliveryComplete(t: IMqttDeliveryToken?) {}
        })
        try {
            c.connect(opts)
            client = c
        } catch (t: Throwable) {
            Timber.e(t, "MQTT initial connect failed")
            connected.set(false)
        }
    }

    /**
     * Re-establish the connection immediately after a network drop rather than
     * waiting out Paho's exponential backoff. No-op when already connected or
     * never connected before. Reuses the last connect params.
     */
    fun kick() {
        if (connected.get()) return
        val p = lastParams ?: return
        // Tear down any half-open client, then reconnect with the stored params.
        runCatching { client?.disconnectForcibly(0, 0) }
        runCatching { client?.close() }
        client = null
        connect(p.broker, p.clientId, p.username, p.password, p.subscribeTopic)
    }

    fun publishAck(topic: String, payload: ByteArray, qos: Int = 1) {
        try {
            client?.publish(topic, payload, qos, false)
        } catch (t: Throwable) {
            Timber.w(t, "MQTT publish failed on $topic")
        }
    }

    @Synchronized
    fun disconnect() {
        runCatching { client?.disconnect() }
        client = null
        connected.set(false)
    }
}

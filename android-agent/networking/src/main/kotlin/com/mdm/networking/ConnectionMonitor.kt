package com.mdm.networking

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Single source of truth for whether the agent is ACTUALLY reaching the server.
 *
 * Written by the heartbeat loop in CommandService (success on a 2xx heartbeat,
 * failure on a non-2xx or a network exception) and read by the UI so the home
 * screen can show a real, live status instead of a hardcoded "connected" string.
 * It's also what the hidden Dev Console reflects after a server-address repoint —
 * so a typo'd IP / wrong port / unreachable host shows as a failure instead of a
 * fake success.
 *
 * In-memory only: a process restart resets it to "unknown" and the first
 * heartbeat re-establishes the real state within ~1s.
 */
@Singleton
class ConnectionMonitor @Inject constructor() {

    data class Status(
        /** Epoch ms of the last successful (2xx) heartbeat; 0 = never yet. */
        val lastOkEpochMs: Long = 0L,
        /** Epoch ms of the last failed heartbeat; 0 = never failed. */
        val lastFailEpochMs: Long = 0L,
        /** Human-readable reason for the most recent failure, null once healthy. */
        val lastError: String? = null,
    )

    private val _status = MutableStateFlow(Status())
    val status: StateFlow<Status> = _status.asStateFlow()

    fun recordSuccess() {
        _status.value = _status.value.copy(
            lastOkEpochMs = System.currentTimeMillis(),
            lastError = null,
        )
    }

    fun recordFailure(error: String) {
        _status.value = _status.value.copy(
            lastFailEpochMs = System.currentTimeMillis(),
            lastError = error,
        )
    }
}

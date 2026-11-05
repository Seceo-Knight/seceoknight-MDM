package com.mdm.networking.api

import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Locks down the wire format. Renaming a JSON field is a fleet-breaking
 * change — these tests fail loudly so we notice in CI.
 */
class ApiModelsTest {

    private val moshi = Moshi.Builder().add(KotlinJsonAdapterFactory()).build()

    @Test
    fun `enroll request serializes with expected snake_case keys`() {
        val adapter = moshi.adapter(EnrollRequest::class.java)
        val json = adapter.toJson(EnrollRequest(
            token = "T",
            serialNumber = "S",
            manufacturer = "M",
            model = "MD",
            osVersion = "14",
            securityPatchLevel = "2024-01-01"
        ))
        listOf(
            "token", "serial_number", "os_version", "security_patch_level"
        ).forEach { assert(json.contains("\"$it\"")) { "missing key $it in $json" } }
    }

    @Test
    fun `enroll response round-trips`() {
        val adapter = moshi.adapter(EnrollResponse::class.java)
        val src = EnrollResponse(
            deviceId = "dev-1",
            tenantId = "tenant-1",
            accessToken = "a",
            refreshToken = "r",
            mqttTopic = "t",
            mqttUser = "u",
            policyUrl = "/api/v1/policies/assigned",
            heartbeatSec = 900
        )
        val parsed = adapter.fromJson(adapter.toJson(src))
        assertEquals(src, parsed)
    }

    @Test
    fun `command dto tolerates missing payload`() {
        val adapter = moshi.adapter(CommandDto::class.java)
        val parsed = adapter.fromJson(
            """{"id":"c1","kind":"LOCK","issued_at":"2026-01-01T00:00:00Z"}"""
        )
        assertEquals("c1", parsed?.id)
        assertEquals("LOCK", parsed?.kind)
        assertEquals(null, parsed?.payload)
    }
}

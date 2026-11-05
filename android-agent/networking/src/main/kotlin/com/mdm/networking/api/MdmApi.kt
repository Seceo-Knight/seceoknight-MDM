package com.mdm.networking.api

import okhttp3.RequestBody
import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Query

/**
 * The complete HTTP surface the agent talks to. All paths are versioned at
 * `/api/v1` and align with the server-side route registrations in:
 *   - device-service/cmd/server/main.go
 *   - auth-service/cmd/server/main.go
 *   - policy-service/cmd/server/main.go
 *   - command-service/cmd/server/main.go
 *   - telemetry-service/cmd/server/main.go
 *   - file-service/cmd/server/main.go
 *
 * The server identifies the calling device from the JWT (via RequireDevice
 * middleware) — that is why these routes do NOT take a deviceId path
 * parameter. Renaming a path here is a fleet-breaking change.
 */
interface MdmApi {

    // ---------- enrollment / auth (no auth header required) ----------
    @POST("api/v1/enroll/")
    suspend fun enroll(@Body req: EnrollRequest): Response<EnrollResponse>

    @POST("api/v1/auth/refresh")
    suspend fun refresh(@Body req: RefreshRequest): Response<RefreshResponse>

    // ---------- policy ----------
    @GET("api/v1/policies/assigned")
    suspend fun getAssignedPolicy(
        @Query("known_version") knownVersion: Int? = null
    ): Response<PolicyEnvelope>

    // ---------- commands ----------
    // wait>0 makes this a LONG-POLL: the server holds the request open until a
    // command is created for this device (or `wait` seconds elapse), so commands
    // arrive near-realtime over plain HTTP — no MQTT. wait=0 is an instant drain
    // (used by the Doze keep-alive tick). Keep wait below the OkHttp readTimeout.
    @GET("api/v1/commands/poll")
    suspend fun pollCommands(@retrofit2.http.Query("wait") waitSec: Int = 0): Response<CommandList>

    @POST("api/v1/commands/{commandId}/ack")
    suspend fun ackCommand(
        @Path("commandId") commandId: String,
        @Body ack: CommandAckDto
    ): Response<Unit>

    @POST("api/v1/commands/{commandId}/result")
    suspend fun postCommandResult(
        @Path("commandId") commandId: String,
        @Body result: CommandResultDto
    ): Response<Unit>

    // ---------- telemetry / heartbeat ----------
    @POST("api/v1/telemetry/ingest")
    suspend fun postTelemetry(@Body batch: TelemetryBatch): Response<Unit>

    @POST("api/v1/devices/me/heartbeat")
    suspend fun postHeartbeat(@Body hb: HeartbeatDto): Response<HeartbeatResponse>

    // Device self-removal: tells the server the MDM agent is being removed from
    // this device so it's soft-retired server-side. Best-effort, fired from the
    // Dev Console "remove agent" action before the app relinquishes admin.
    @POST("api/v1/devices/me/unenroll")
    suspend fun unenroll(): Response<Unit>

    // ---------- files (APK / cert / config) ----------
    @GET("api/v1/files/{objectId}/url")
    suspend fun presignDownload(@Path("objectId") objectId: String): Response<PresignResponse>

    // Used to fetch the bytes directly when the server hands back a raw download URL.
    @GET
    suspend fun downloadRaw(@retrofit2.http.Url url: String): Response<ResponseBody>

    @PUT
    suspend fun uploadRaw(
        @retrofit2.http.Url url: String,
        @Body body: RequestBody
    ): Response<Unit>

    // ---------- device-authored uploads (camera, log bundles) ----------
    @retrofit2.http.Multipart
    @POST("api/v1/files/device-upload")
    suspend fun deviceUpload(
        @retrofit2.http.Part file: okhttp3.MultipartBody.Part,
        @retrofit2.http.Part("kind") kind: RequestBody,
        @retrofit2.http.Part("name") name: RequestBody
    ): Response<DeviceUploadResponse>
}

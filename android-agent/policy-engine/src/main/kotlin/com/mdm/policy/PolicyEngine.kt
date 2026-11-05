package com.mdm.policy

import com.mdm.networking.api.MdmApi
import com.mdm.networking.auth.AuthRepository
import com.squareup.moshi.Moshi
import com.squareup.moshi.adapter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Fetches the current policy envelope for this device, decodes the typed
 * [PolicySpec], and hands it to [PolicyApplier]. The server returns the
 * full policy each time (not a diff) — diffs only matter for *audit*, not
 * for device-side application, since [PolicyApplier] is idempotent.
 *
 * Versioning: we send the last-applied version so the server can return
 * 304-style "unchanged" responses (envelope with the same version field)
 * and we short-circuit without re-applying.
 */
@Singleton
class PolicyEngine @Inject constructor(
    private val api: MdmApi,
    private val auth: AuthRepository,
    private val applier: PolicyApplier,
    moshi: Moshi
) {
    // Server emits PolicySpec inside `spec` as an opaque map; we re-encode and
    // re-decode through kotlinx-serialization so we get the strict typed model.
    private val anyAdapter = moshi.adapter<Map<String, Any?>>(
        com.squareup.moshi.Types.newParameterizedType(Map::class.java, String::class.java, Any::class.java)
    )
    // ignoreUnknownKeys=true: the server's PolicySpec and the agent's
    // PolicySpec evolve independently. A new server-side field (e.g.
    // top-level "version", a newer compliance check) must NOT make the
    // agent's parse fail — that turns APPLY_POLICY into a silent no-op
    // (the command shows succeeded with {} result, nothing actually applies).
    // Strictness lives in policy authoring (linter on save), not at the
    // device-side decoder.
    private val json = Json { ignoreUnknownKeys = true; isLenient = false }

    private var lastVersion: Int = 0

    /**
     * Resets the cached "last applied policy version" so the next APPLY_POLICY
     * isn't short-circuited as "unchanged". CLEAR_POLICY calls this so that a
     * subsequent reassignment doesn't no-op the way `if env.version == lastVersion`
     * normally does.
     */
    fun resetLocalVersion() {
        lastVersion = 0
    }

    /** Returns the version applied, or null if no sync happened. */
    @OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
    suspend fun sync(): Int? = withContext(Dispatchers.IO) {
        if (!auth.isEnrolled()) {
            Timber.w("PolicyEngine.sync: not enrolled"); return@withContext null
        }
        val resp = runCatching { api.getAssignedPolicy(lastVersion.takeIf { it > 0 }) }
            .onFailure { Timber.e(it, "policy fetch failed") }
            .getOrNull() ?: return@withContext null
        if (!resp.isSuccessful) {
            Timber.w("policy fetch HTTP ${resp.code()}"); return@withContext null
        }
        val env = resp.body() ?: return@withContext null
        if (env.version == lastVersion && lastVersion > 0) {
            Timber.d("policy unchanged at v$lastVersion"); return@withContext lastVersion
        }

        // Round-trip through JSON to get a typed PolicySpec via kotlinx.
        val raw = anyAdapter.toJson(env.spec)
        val spec = runCatching { json.decodeFromString(PolicySpec.serializer(), raw) }
            .onFailure { Timber.e(it, "policy spec parse failed; raw=$raw") }
            .getOrNull() ?: return@withContext null

        Timber.i("Applying policy v${env.version} (${env.policyId}): " +
                 "restrictions=${spec.restrictions != null} apps=${spec.apps != null} " +
                 "security=${spec.security != null} blocklist=${spec.apps?.blocklist?.size ?: 0} " +
                 "url_blocklist=${spec.apps?.url_blocklist?.size ?: 0} " +
                 "capture_on_unlock=${spec.security?.capture_on_unlock}")
        applier.apply(spec)
        lastVersion = env.version
        Timber.i("policy v${env.version} applied (${env.policyId})")
        env.version
    }
}

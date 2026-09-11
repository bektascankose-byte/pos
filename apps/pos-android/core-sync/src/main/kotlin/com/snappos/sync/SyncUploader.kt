package com.snappos.sync

import android.util.Log
import com.snappos.data.dao.ConfigDao
import com.snappos.data.dao.OutboxDao
import com.snappos.data.dao.SalesDao
import com.snappos.data.entities.OutboxEntity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.min
import kotlin.math.pow

/**
 * Draining the outbox.
 *
 * The register half of "a completed sale is never lost and never duplicated".
 * The sale is already safe on device before this class ever runs; its only job
 * is to hand it over, and it is allowed to be as clumsy about that as the
 * network forces it to be.
 *
 * Three outcomes per entity, and the middle one is the important one:
 *
 *   accepted   inserted on the server now
 *   duplicate  already there. **A success.** This is the normal result of a
 *              retry after a response was lost, and it is treated exactly like
 *              accepted. Anything else would make a lost response look like a
 *              lost sale.
 *   rejected   the server refused it. Retryable failures back off; the rest
 *              go to the dead letter list after five attempts, which is a
 *              state a manager can see rather than a hole in the day's numbers.
 */
@Singleton
class SyncUploader @Inject constructor(
  private val api: SnapPosApi,
  private val outbox: OutboxDao,
  private val sales: SalesDao,
  private val config: ConfigDao,
) {

  private val json = Json { ignoreUnknownKeys = true }

  data class Outcome(
    val uploaded: Int = 0,
    val duplicates: Int = 0,
    val rejected: Int = 0,
    val deadLettered: Int = 0,
    val remaining: Int = 0,
    val failure: String? = null,
  ) {
    val madeProgress: Boolean get() = uploaded > 0 || duplicates > 0
  }

  /**
   * Upload one batch.
   *
   * Fifty at a time, oldest first: a sale from two hours ago has been
   * unacknowledged longer and is the one at risk if this device dies.
   */
  suspend fun drainOnce(limit: Int = BATCH_SIZE): Outcome {
    val registerConfig = config.get() ?: return Outcome(failure = "device not claimed")
    val now = System.currentTimeMillis()
    val batch = outbox.nextBatch(now, limit)
    if (batch.isEmpty()) return Outcome()

    val envelopes = batch.map { entry ->
      SyncEnvelope(
        id = entry.entityId,
        entity_type = entry.entityType,
        device_time = Iso8601.format(entry.deviceTimeMillis),
        attempt = entry.attempts,
        payload = json.decodeFromString(JsonObject.serializer(), entry.payloadJson),
      )
    }

    val response = try {
      api.upload(
        SyncBatchRequest(
          register_id = registerConfig.registerId,
          device_id = registerConfig.deviceId,
          entities = envelopes,
        ),
      )
    } catch (e: Exception) {
      // No network, DNS failure, timeout. Nothing was rejected, so nothing is
      // penalised: the whole batch simply waits and is tried again. Counting
      // this as an attempt would march sales toward the dead letter list
      // purely because the shop's internet was down, which is the single most
      // common reason this code runs at all.
      Log.i(TAG, "upload could not reach the server: ${e.message}")
      return Outcome(remaining = batch.size, failure = e.message ?: "network unavailable")
    }

    if (!response.isSuccessful) {
      val code = response.code()
      val body = response.errorBody()?.string()

      // 401 means the token expired. The interceptor already tried to refresh,
      // so reaching here means re-authentication is needed - a person problem,
      // not a retry problem.
      val retryable = code == 401 || code == 429 || code >= 500
      if (!retryable) {
        batch.forEach { penalise(it, "HTTP $code: ${body?.take(200)}") }
      }
      Log.w(TAG, "upload rejected with HTTP $code")
      return Outcome(remaining = batch.size, failure = "HTTP $code")
    }

    val payload = response.body() ?: return Outcome(
      remaining = batch.size,
      failure = "empty response",
    )

    config.setClockOffset(payload.clock_offset_ms)

    val byId = batch.associateBy { it.entityId }
    val acknowledged = mutableListOf<String>()
    var uploaded = 0
    var duplicates = 0
    var rejected = 0
    var dead = 0

    for (result in payload.results) {
      val entry = byId[result.id] ?: continue
      when (result.status) {
        "accepted" -> { uploaded++; acknowledged += result.id }
        // Identical handling to accepted, on purpose.
        "duplicate" -> { duplicates++; acknowledged += result.id }
        else -> {
          rejected++
          val retryable = result.error?.retryable ?: false
          if (!retryable && entry.attempts + 1 >= MAX_ATTEMPTS) dead++
          penalise(entry, result.error?.message ?: "rejected", retryable)
        }
      }
    }

    if (acknowledged.isNotEmpty()) {
      outbox.acknowledge(acknowledged)
      // The sale row's own state too, so the register can show which sales are
      // safely handed over without joining to the outbox on every render.
      acknowledged.forEach { sales.setSyncState(it, "acknowledged") }
    }

    return Outcome(
      uploaded = uploaded,
      duplicates = duplicates,
      rejected = rejected,
      deadLettered = dead,
      remaining = (batch.size - acknowledged.size).coerceAtLeast(0),
    )
  }

  /** Drain until the queue is empty or nothing more can be sent right now. */
  suspend fun drainAll(maxBatches: Int = 20): Outcome {
    var total = Outcome()
    repeat(maxBatches) {
      val outcome = drainOnce()
      total = Outcome(
        uploaded = total.uploaded + outcome.uploaded,
        duplicates = total.duplicates + outcome.duplicates,
        rejected = total.rejected + outcome.rejected,
        deadLettered = total.deadLettered + outcome.deadLettered,
        remaining = outcome.remaining,
        failure = outcome.failure,
      )
      // Stop on no work, or on a batch that made no progress: retrying a
      // failing batch in a tight loop only burns battery.
      if (!outcome.madeProgress) return total
    }
    return total
  }

  /**
   * Record a failure and schedule the next attempt.
   *
   * Exponential backoff from 5 seconds, capped at 15 minutes. The cap matters:
   * an uncapped doubling reaches hours, and a sale that could have uploaded
   * would sit unsent for a whole shift because of one bad afternoon.
   */
  private suspend fun penalise(entry: OutboxEntity, error: String, retryable: Boolean = true) {
    val attempts = entry.attempts + 1
    val dead = !retryable && attempts >= MAX_ATTEMPTS
    val backoff = min(
      BASE_BACKOFF_MS * 2.0.pow(attempts - 1).toLong(),
      MAX_BACKOFF_MS,
    )

    outbox.recordFailure(
      entityId = entry.entityId,
      state = if (dead) "dead" else "pending",
      now = System.currentTimeMillis(),
      error = error.take(500),
      nextAttempt = System.currentTimeMillis() + backoff,
    )

    if (dead) {
      Log.e(TAG, "entity ${entry.entityId} dead lettered after $attempts attempts: $error")
      sales.setSyncState(entry.entityId, "failed")
    }
  }

  private companion object {
    const val TAG = "SyncUploader"
    const val BATCH_SIZE = 50
    const val MAX_ATTEMPTS = 5
    const val BASE_BACKOFF_MS = 5_000L
    const val MAX_BACKOFF_MS = 15 * 60 * 1000L
  }
}

/** ISO 8601 with an offset, as the server's contracts require. */
internal object Iso8601 {
  fun format(millis: Long): String =
    java.time.Instant.ofEpochMilli(millis)
      .atZone(java.time.ZoneId.systemDefault())
      .format(java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME)
}

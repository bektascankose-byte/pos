package com.snappos.data

import com.snappos.data.dao.CashBreakdownRow
import com.snappos.data.dao.CashDao
import com.snappos.data.dao.ConfigDao
import com.snappos.data.entities.CashMovementEntity
import com.snappos.data.entities.CashSessionEntity
import com.snappos.data.entities.OutboxEntity
import com.snappos.domain.Money
import com.snappos.domain.Uuid7
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

data class DrawerStatus(
  val sessionId: String,
  val openedAtMillis: Long,
  val openingFloat: Money,
  val blind: Boolean,
  /** Withheld on an open blind session; that is the whole point of blind. */
  val expected: Money?,
  val breakdown: List<CashBreakdownRow>,
)

data class CloseResult(
  val counted: Money,
  val expected: Money,
  val variance: Money,
) {
  /** Negative is short, positive is over. Named because "-500" is ambiguous at a glance. */
  val outcome: String get() = when {
    variance.isZero -> "balanced"
    variance.isNegative -> "short"
    else -> "over"
  }
}

/**
 * The cash drawer, on device.
 *
 * Mirrors the server's model exactly, because the register has to be able to
 * run a whole shift with no network and hand the result over afterwards. Every
 * movement is a row, including the opening float, so expected cash is always
 * the sum of movements and never a counter something increments.
 */
@Singleton
class CashRepository @Inject constructor(
  private val cash: CashDao,
  private val config: ConfigDao,
) {

  private val json = Json { encodeDefaults = true }

  fun observeOpenSession(registerId: String): Flow<CashSessionEntity?> =
    cash.observeOpenSession(registerId)

  suspend fun openSessionId(): String? {
    val registerId = config.get()?.registerId ?: return null
    return cash.openSessionFor(registerId)?.id
  }

  /**
   * Open a drawer.
   *
   * The opening float is written as a movement like any other, so there is no
   * special case anywhere downstream for "where did the first $200 come from".
   */
  suspend fun open(
    openedBy: String,
    openingFloat: Money,
    blind: Boolean = true,
  ): Result<String> {
    val registerConfig = config.get()
      ?: return Result.failure(IllegalStateException("this device is not provisioned"))

    cash.openSessionFor(registerConfig.registerId)?.let {
      // One open session per register. Two would make over/short meaningless,
      // because nobody could say which session a given note belonged to.
      return Result.failure(IllegalStateException("the drawer is already open"))
    }

    val sessionId = Uuid7.generate()
    val now = System.currentTimeMillis()

    val session = CashSessionEntity(
      id = sessionId,
      storeId = registerConfig.storeId,
      registerId = registerConfig.registerId,
      openedBy = openedBy,
      openedAtMillis = now,
      openingFloatMinor = openingFloat.minor,
      blind = blind,
    )

    val float = CashMovementEntity(
      id = Uuid7.generate(),
      sessionId = sessionId,
      kind = "opening_float",
      amountMinor = openingFloat.minor,
      reason = "session opened",
      actorUserId = openedBy,
      occurredAtMillis = now,
    )

    cash.openSession(
      session,
      float,
      OutboxEntity(
        id = Uuid7.generate(),
        entityType = "cash_session",
        entityId = sessionId,
        payloadJson = json.encodeToString(
          JsonObject.serializer(),
          buildJsonObject {
            put("store_id", registerConfig.storeId)
            put("register_id", registerConfig.registerId)
            put("opened_by", openedBy)
            put("opening_float_minor", openingFloat.minor.toString())
            put("blind", blind)
            put("opened_at", Iso8601.format(now))
          },
        ),
        deviceTimeMillis = now,
        createdAtMillis = now,
        state = "pending",
        attempts = 0,
        lastAttemptMillis = null,
        lastError = null,
        nextAttemptMillis = 0,
      ),
    )

    return Result.success(sessionId)
  }

  /**
   * Record a movement of cash.
   *
   * Called by the sale path for each cash tender, and by a manager for paid in,
   * paid out, drops and pickups.
   */
  suspend fun recordMovement(
    sessionId: String,
    kind: String,
    amount: Money,
    actorUserId: String,
    reason: String? = null,
    referenceType: String? = null,
    referenceId: String? = null,
    occurredAtMillis: Long = System.currentTimeMillis(),
    movementId: String = Uuid7.generate(),
  ) {
    cash.insertMovement(
      CashMovementEntity(
        id = movementId,
        sessionId = sessionId,
        kind = kind,
        amountMinor = amount.minor,
        reason = reason,
        referenceType = referenceType,
        referenceId = referenceId,
        actorUserId = actorUserId,
        occurredAtMillis = occurredAtMillis,
      ),
    )

    // Only movements that are not already implied by another document are
    // queued on their own. A cash tender travels inside its sale, and uploading
    // it twice would double the drawer.
    if (kind != "sale" && kind != "refund" && kind != "opening_float") {
      cash.insertOutbox(
        OutboxEntity(
          id = Uuid7.generate(),
          entityType = "cash_movement",
          entityId = movementId,
          payloadJson = json.encodeToString(
            JsonObject.serializer(),
            buildJsonObject {
              put("session_id", sessionId)
              put("kind", kind)
              put("amount_minor", amount.minor.toString())
              reason?.let { put("reason", it) }
              put("actor_user_id", actorUserId)
              put("occurred_at", Iso8601.format(occurredAtMillis))
            },
          ),
          deviceTimeMillis = occurredAtMillis,
          createdAtMillis = System.currentTimeMillis(),
          state = "pending",
          attempts = 0,
          lastAttemptMillis = null,
          lastError = null,
          nextAttemptMillis = 0,
        ),
      )
    }
  }

  suspend fun status(sessionId: String): DrawerStatus? {
    val session = cash.sessionById(sessionId) ?: return null
    val expected = Money.ofMinor(cash.expectedCash(sessionId))
    val stillBlind = session.blind && session.closedAtMillis == null

    return DrawerStatus(
      sessionId = session.id,
      openedAtMillis = session.openedAtMillis,
      openingFloat = Money.ofMinor(session.openingFloatMinor),
      blind = session.blind,
      expected = if (stillBlind) null else expected,
      breakdown = cash.breakdown(sessionId),
    )
  }

  /**
   * Close against a counted amount.
   *
   * The expected total is computed at this moment, not earlier, so a blind
   * count stays blind right up until it is committed.
   */
  suspend fun close(
    sessionId: String,
    closedBy: String,
    counted: Money,
    note: String? = null,
  ): Result<CloseResult> {
    val session = cash.sessionById(sessionId)
      ?: return Result.failure(IllegalStateException("no such session"))
    if (session.closedAtMillis != null) {
      return Result.failure(IllegalStateException("this session is already closed"))
    }

    val expected = Money.ofMinor(cash.expectedCash(sessionId))
    val now = System.currentTimeMillis()

    cash.insertMovement(
      CashMovementEntity(
        id = Uuid7.generate(),
        sessionId = sessionId,
        kind = "closing_count",
        amountMinor = 0,
        reason = "session closed",
        actorUserId = closedBy,
        occurredAtMillis = now,
      ),
    )

    cash.closeSession(sessionId, closedBy, now, counted.minor, expected.minor, note)

    cash.insertOutbox(
      OutboxEntity(
        id = Uuid7.generate(),
        entityType = "cash_session_close",
        // Its own id, not a composite of the session's. Every entity id must be
        // a UUIDv7 the server will accept; "<uuid>:close" is not one, and using
        // it made the whole upload batch fail validation rather than just this
        // entity. The session it closes travels in the payload.
        entityId = Uuid7.generate(),
        payloadJson = json.encodeToString(
          JsonObject.serializer(),
          buildJsonObject {
            put("session_id", sessionId)
            put("closed_by", closedBy)
            put("counted_minor", counted.minor.toString())
            put("expected_minor", expected.minor.toString())
            note?.let { put("note", it) }
            put("closed_at", Iso8601.format(now))
          },
        ),
        deviceTimeMillis = now,
        createdAtMillis = now,
        state = "pending",
        attempts = 0,
        lastAttemptMillis = null,
        lastError = null,
        nextAttemptMillis = 0,
      ),
    )

    return Result.success(
      CloseResult(counted = counted, expected = expected, variance = counted - expected),
    )
  }
}

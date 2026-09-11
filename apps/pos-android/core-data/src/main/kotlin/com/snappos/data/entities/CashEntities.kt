package com.snappos.data.entities

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * A drawer session on this device.
 *
 * Opened at the start of a shift and closed against a counted amount. The
 * number an owner actually looks at is over/short, and getting it right means
 * every movement of cash is a row — the opening float included.
 *
 * Expected cash is never stored. It is the sum of the session's movements,
 * computed when asked, exactly as the server does it. A stored running total
 * drifts the first time a write is retried, and a drawer figure that drifts is
 * worse than none at all because people trust it.
 */
@Entity(tableName = "cash_sessions", indices = [Index("registerId"), Index("closedAtMillis")])
data class CashSessionEntity(
  /** UUIDv7, minted on device. Doubles as its idempotency key on upload. */
  @PrimaryKey val id: String,
  val storeId: String,
  val registerId: String,
  val openedBy: String,
  val openedAtMillis: Long,
  val openingFloatMinor: Long,
  /**
   * A blind count hides the expected total from the person counting. It is the
   * only kind that measures anything: shown the number first, people type it
   * back and the count confirms itself rather than the drawer.
   */
  val blind: Boolean,
  val closedBy: String? = null,
  val closedAtMillis: Long? = null,
  val countedMinor: Long? = null,
  val expectedMinor: Long? = null,
  val note: String? = null,
  val syncState: String = "pending",
)

/**
 * One movement of cash.
 *
 * Signed: a paid out is negative, a paid in positive. A cash sale records the
 * amount, never the tender — handing over $50 for a $43 sale puts $43 in the
 * drawer and $7 back in the customer's hand, and counting the tender would make
 * every drawer over by the change given.
 */
@Entity(
  tableName = "cash_movements",
  indices = [Index("sessionId"), Index("occurredAtMillis")],
)
data class CashMovementEntity(
  @PrimaryKey val id: String,
  val sessionId: String,
  /** opening_float, sale, refund, paid_in, paid_out, drop, pickup, closing_count */
  val kind: String,
  val amountMinor: Long,
  val reason: String? = null,
  val referenceType: String? = null,
  val referenceId: String? = null,
  val actorUserId: String,
  val occurredAtMillis: Long,
  val note: String? = null,
)

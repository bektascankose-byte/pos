package com.snappos.data.entities

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * A refund composed on this device.
 *
 * Append only, like a sale: a refund is a historical fact and is never edited.
 * `syncState` is the one mutable column.
 *
 * `approvedBy` is not optional in practice even though the column allows null.
 * A refund is the single most common vector for employee theft in retail, so
 * the register requires a manager PIN before one can be composed at all, and
 * the name of whoever approved it is what makes the loss prevention report
 * worth reading.
 */
@Entity(
  tableName = "refunds",
  indices = [Index("syncState"), Index("originalSaleId"), Index("completedAtMillis")],
)
data class RefundEntity(
  /** UUIDv7, minted on device. Doubles as its idempotency key on upload. */
  @PrimaryKey val id: String,
  val storeId: String,
  val registerId: String,
  val sessionId: String?,
  /**
   * The sale being refunded.
   *
   * Null is permitted by the schema because a no-receipt refund is a real thing
   * a shop sometimes does, but the register does not offer one yet: without an
   * original there is nothing to check a quantity against, and that is exactly
   * the hole theft goes through.
   */
  val originalSaleId: String?,
  val cashierUserId: String,
  val approvedBy: String?,
  val receiptNo: String,
  val reasonCode: String,
  val reasonNote: String?,
  val subtotalMinor: Long,
  val taxMinor: Long,
  val totalMinor: Long,
  val restock: Boolean,
  val deviceTimeMillis: Long,
  val completedAtMillis: Long,
  val syncState: String = "pending",
)

@Entity(tableName = "refund_lines", indices = [Index("refundId"), Index("saleLineId")])
data class RefundLineEntity(
  @PrimaryKey val id: String,
  val refundId: String,
  /** The line being refunded. What makes over-refunding checkable. */
  val saleLineId: String?,
  val variantId: String,
  val description: String,
  val quantity: String,
  val unitPriceMinor: Long,
  val taxMinor: Long,
  val totalMinor: Long,
  val unitCost: String,
  /**
   * Whether the item goes back on the shelf.
   *
   * An opened drink is refunded and not restocked. Restocking it anyway would
   * make the count drift by exactly the number of damaged returns, which is the
   * kind of slow error that takes a full physical count to find.
   */
  val restocked: Boolean,
  val condition: String?,
)

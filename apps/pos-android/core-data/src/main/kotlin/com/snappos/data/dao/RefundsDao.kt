package com.snappos.data.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import com.snappos.data.entities.OutboxEntity
import com.snappos.data.entities.RefundEntity
import com.snappos.data.entities.RefundLineEntity
import com.snappos.data.entities.SaleEntity
import com.snappos.data.entities.PaymentEntity
import com.snappos.data.entities.SaleLineEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface RefundsDao {

  /**
   * Look a sale up by the number printed on its receipt.
   *
   * This is what a cashier actually has in their hand. The sale's id is a
   * UUIDv7 nobody can read off a piece of paper.
   */
  @Query("SELECT * FROM sales WHERE receiptNo = :receiptNo LIMIT 1")
  suspend fun saleByReceipt(receiptNo: String): SaleEntity?

  @Query("SELECT * FROM sale_lines WHERE saleId = :saleId ORDER BY lineNo")
  suspend fun linesFor(saleId: String): List<SaleLineEntity>

  /**
   * Commit a refund and queue it, in one transaction.
   *
   * The same rule as a sale, for the same reason: the refund, its lines, the
   * claim against the original quantities and the outbox row land together or
   * not at all. A refund the server never hears about would leave the original
   * sale looking fully refundable forever.
   */
  @Transaction
  suspend fun commitRefund(
    refund: RefundEntity,
    lines: List<RefundLineEntity>,
    claims: List<Pair<String, String>>,
    outbox: OutboxEntity,
  ) {
    insertRefund(refund)
    insertLines(lines)
    for ((saleLineId, quantity) in claims) {
      claimRefundedQuantity(saleLineId, quantity)
    }
    insertOutbox(outbox)
  }

  @Insert(onConflict = OnConflictStrategy.IGNORE)
  suspend fun insertRefund(refund: RefundEntity)

  @Insert(onConflict = OnConflictStrategy.IGNORE)
  suspend fun insertLines(lines: List<RefundLineEntity>)

  @Insert(onConflict = OnConflictStrategy.IGNORE)
  suspend fun insertOutbox(entry: OutboxEntity)

  /**
   * Claim refunded units against the original line.
   *
   * SQLite has no numeric type that survives this safely, so the arithmetic is
   * done as a decimal string cast at write time. The server's numeric(14,3)
   * column is the authority; this copy exists so an over-refund is caught at
   * the counter rather than on upload, after the customer has the money.
   */
  @Query(
    """
    UPDATE sale_lines
    SET quantityRefunded = CAST(
      (CAST(quantityRefunded AS REAL) + CAST(:quantity AS REAL)) AS TEXT
    )
    WHERE id = :saleLineId
    """,
  )
  suspend fun claimRefundedQuantity(saleLineId: String, quantity: String)

  /**
   * Mark a sale voided, and queue the void, in one transaction.
   *
   * The same rule as a sale and a refund, for the same reason: a void the
   * server never hears about leaves a sale standing that the shop has already
   * reversed, with the money out of the drawer and the stock back on the shelf
   * on this device only.
   */
  @Transaction
  suspend fun commitVoid(
    saleId: String,
    voidedAtMillis: Long,
    voidedBy: String,
    reason: String,
    outbox: OutboxEntity,
  ): Boolean {
    // `markVoided` only matches a sale that is not already voided, so a zero
    // here means something voided it in between the repository's check and
    // this transaction. Queuing anyway would upload a void for a sale already
    // reversed - harmless on the server, which is idempotent, but it puts a row
    // in the outbox that says something happened twice when it happened once.
    if (markVoided(saleId, voidedAtMillis, voidedBy, reason) == 0) return false
    insertOutbox(outbox)
    return true
  }

  @Query(
    """
    UPDATE sales
    SET status = 'voided',
        voidedAtMillis = :voidedAtMillis,
        voidedBy = :voidedBy,
        voidReason = :reason
    WHERE id = :saleId AND status != 'voided'
    """,
  )
  suspend fun markVoided(
    saleId: String,
    voidedAtMillis: Long,
    voidedBy: String,
    reason: String,
  ): Int

  @Query("SELECT * FROM sales WHERE id = :saleId")
  suspend fun saleById(saleId: String): SaleEntity?

  /** Cash tenders on a sale, so voiding can take exactly those back out. */
  @Query("SELECT * FROM payments WHERE saleId = :saleId AND method = 'cash'")
  suspend fun cashPaymentsFor(saleId: String): List<PaymentEntity>

  @Query("SELECT * FROM refunds ORDER BY completedAtMillis DESC LIMIT :limit")
  fun recent(limit: Int = 50): Flow<List<RefundEntity>>

  @Query("UPDATE refunds SET syncState = :state WHERE id = :id")
  suspend fun setSyncState(id: String, state: String)

  @Query("SELECT count(*) FROM refunds WHERE syncState != 'acknowledged'")
  fun unsyncedCount(): Flow<Int>
}

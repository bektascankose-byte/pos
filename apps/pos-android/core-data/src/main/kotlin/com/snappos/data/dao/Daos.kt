package com.snappos.data.dao

import androidx.room.Dao
import androidx.room.Embedded
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import com.snappos.data.entities.AgeVerificationEntity
import com.snappos.data.entities.BarcodeEntity
import com.snappos.data.entities.CategoryEntity
import com.snappos.data.entities.EmployeeEntity
import com.snappos.data.entities.InventoryEntity
import com.snappos.data.entities.OutboxEntity
import com.snappos.data.entities.PaymentEntity
import com.snappos.data.entities.PriceEntity
import com.snappos.data.entities.RegisterConfigEntity
import com.snappos.data.entities.SaleEntity
import com.snappos.data.entities.SaleLineEntity
import com.snappos.data.entities.VariantEntity
import kotlinx.coroutines.flow.Flow

/** What a scan resolves to: everything the cart needs, in one row. */
data class ScannedItem(
  @Embedded val variant: VariantEntity,
  val scanUnits: String,
  val priceMinor: Long?,
  val onHand: String?,
)

@Dao
interface CatalogDao {

  /**
   * Resolve a barcode.
   *
   * The hottest query in the building, and its shape is dictated by one number:
   * a scan must reach the cart in under 120ms. One indexed lookup on the
   * barcode primary key, joins on primary keys, and the price picked by a
   * correlated subquery rather than a second round trip.
   *
   * Price, stock and the age rule all come back together, because the
   * compliance prompt has to be decidable before the line renders. Deciding it
   * afterwards would let a cashier add a restricted item without being asked.
   */
  @Query(
    """
    SELECT v.*, b.units AS scanUnits,
           (SELECT p.priceMinor FROM prices p
             WHERE p.variantId = v.id AND p.kind = 'regular'
               AND p.effectiveFrom <= :now
               AND (p.effectiveTo IS NULL OR p.effectiveTo > :now)
             ORDER BY p.effectiveFrom DESC LIMIT 1) AS priceMinor,
           (SELECT i.onHand FROM inventory i WHERE i.variantId = v.id) AS onHand
    FROM barcodes b
    JOIN variants v ON v.id = b.variantId
    WHERE b.barcode = :barcode AND v.status = 'active'
    LIMIT 1
    """,
  )
  suspend fun resolveBarcode(barcode: String, now: Long): ScannedItem?

  /**
   * Search.
   *
   * `LIKE` over a denormalized `searchText` column rather than a join across
   * six tables on every keystroke. A single store has thousands of SKUs, not
   * millions, and this answers in single digit milliseconds on device. FTS5 is
   * the upgrade path when the catalog size or typo tolerance demands it.
   */
  @Query(
    """
    SELECT v.*, '1' AS scanUnits,
           (SELECT p.priceMinor FROM prices p
             WHERE p.variantId = v.id AND p.kind = 'regular'
               AND p.effectiveFrom <= :now
               AND (p.effectiveTo IS NULL OR p.effectiveTo > :now)
             ORDER BY p.effectiveFrom DESC LIMIT 1) AS priceMinor,
           (SELECT i.onHand FROM inventory i WHERE i.variantId = v.id) AS onHand
    FROM variants v
    WHERE v.status = 'active' AND v.searchText LIKE '%' || :query || '%'
    ORDER BY v.productName, v.sortOrder
    LIMIT :limit
    """,
  )
  suspend fun search(query: String, now: Long, limit: Int = 50): List<ScannedItem>

  @Query(
    """
    SELECT v.*, '1' AS scanUnits,
           (SELECT p.priceMinor FROM prices p
             WHERE p.variantId = v.id AND p.kind = 'regular'
               AND p.effectiveFrom <= :now
               AND (p.effectiveTo IS NULL OR p.effectiveTo > :now)
             ORDER BY p.effectiveFrom DESC LIMIT 1) AS priceMinor,
           (SELECT i.onHand FROM inventory i WHERE i.variantId = v.id) AS onHand
    FROM variants v
    WHERE v.status = 'active' AND (:categoryId IS NULL OR v.categoryId = :categoryId)
    ORDER BY v.productName, v.sortOrder
    LIMIT :limit
    """,
  )
  suspend fun byCategory(categoryId: String?, now: Long, limit: Int = 200): List<ScannedItem>

  @Query("SELECT * FROM categories ORDER BY sortOrder, name")
  fun categories(): Flow<List<CategoryEntity>>

  @Upsert suspend fun upsertVariants(variants: List<VariantEntity>)

  @Upsert suspend fun upsertBarcodes(barcodes: List<BarcodeEntity>)

  @Upsert suspend fun upsertPrices(prices: List<PriceEntity>)

  @Upsert suspend fun upsertCategories(categories: List<CategoryEntity>)

  @Upsert suspend fun upsertInventory(levels: List<InventoryEntity>)

  @Query("SELECT count(*) FROM variants")
  suspend fun variantCount(): Int
}

@Dao
interface EmployeeDao {
  @Query("SELECT * FROM employees WHERE status = 'active' ORDER BY displayName")
  fun active(): Flow<List<EmployeeEntity>>

  @Query("SELECT * FROM employees WHERE id = :id")
  suspend fun byId(id: String): EmployeeEntity?

  @Query("SELECT * FROM employees WHERE employeeCode = :code AND status = 'active'")
  suspend fun byCode(code: String): EmployeeEntity?

  @Upsert suspend fun upsert(employees: List<EmployeeEntity>)

  /**
   * PIN lockout, counted on device.
   *
   * A four digit PIN is 10,000 combinations, so lockout is what protects it and
   * not hashing cost. Counting on device matters because the register is
   * offline exactly when someone is most likely to be trying PINs at it.
   */
  @Query(
    "UPDATE employees SET failedPinAttempts = :attempts, lockedUntilMillis = :lockedUntil WHERE id = :id",
  )
  suspend fun recordPinAttempt(id: String, attempts: Int, lockedUntil: Long?)
}

@Dao
interface SalesDao {

  /**
   * Commit a sale and queue it, in one transaction.
   *
   * This is the most important method in the register. Either everything lands
   * or nothing does: a sale written without its outbox row is a sale the server
   * never hears about, and an outbox row without its sale would upload
   * something that does not exist.
   *
   * Nothing here touches the network. The cashier is done the moment it returns.
   */
  @Transaction
  suspend fun commitSale(
    sale: SaleEntity,
    lines: List<SaleLineEntity>,
    payments: List<PaymentEntity>,
    ageChecks: List<AgeVerificationEntity>,
    outbox: OutboxEntity,
  ) {
    insertSale(sale)
    insertLines(lines)
    insertPayments(payments)
    if (ageChecks.isNotEmpty()) insertAgeChecks(ageChecks)
    insertOutbox(outbox)
  }

  // IGNORE rather than REPLACE: a completed sale is a historical fact, and
  // re-inserting one must never overwrite what was actually charged.
  @Insert(onConflict = OnConflictStrategy.IGNORE)
  suspend fun insertSale(sale: SaleEntity)

  @Insert(onConflict = OnConflictStrategy.IGNORE)
  suspend fun insertLines(lines: List<SaleLineEntity>)

  @Insert(onConflict = OnConflictStrategy.IGNORE)
  suspend fun insertPayments(payments: List<PaymentEntity>)

  @Insert(onConflict = OnConflictStrategy.IGNORE)
  suspend fun insertAgeChecks(checks: List<AgeVerificationEntity>)

  @Insert(onConflict = OnConflictStrategy.IGNORE)
  suspend fun insertOutbox(entry: OutboxEntity)

  @Query("SELECT * FROM sales WHERE id = :id")
  suspend fun byId(id: String): SaleEntity?

  @Query("SELECT * FROM sale_lines WHERE saleId = :saleId ORDER BY lineNo")
  suspend fun linesFor(saleId: String): List<SaleLineEntity>

  @Query("SELECT * FROM payments WHERE saleId = :saleId")
  suspend fun paymentsFor(saleId: String): List<PaymentEntity>

  @Query("SELECT * FROM sales ORDER BY completedAtMillis DESC LIMIT :limit")
  fun recent(limit: Int = 50): Flow<List<SaleEntity>>

  @Query("UPDATE sales SET syncState = :state WHERE id = :id")
  suspend fun setSyncState(id: String, state: String)

  /** Completed sales that have not reached the server. Shown in the header. */
  @Query("SELECT count(*) FROM sales WHERE syncState != 'acknowledged'")
  fun unsyncedCount(): Flow<Int>
}

@Dao
interface OutboxDao {

  /**
   * The next batch to upload, oldest first.
   *
   * Oldest first because a sale from two hours ago matters more than one from
   * two seconds ago: it has been unacknowledged longer and is the one at risk
   * if this device dies.
   */
  @Query(
    """
    SELECT * FROM sync_outbox
    WHERE state = 'pending' AND nextAttemptMillis <= :now
    ORDER BY createdAtMillis ASC
    LIMIT :limit
    """,
  )
  suspend fun nextBatch(now: Long, limit: Int = 50): List<OutboxEntity>

  @Query("UPDATE sync_outbox SET state = 'acknowledged' WHERE entityId IN (:ids)")
  suspend fun acknowledge(ids: List<String>)

  @Query(
    """
    UPDATE sync_outbox
    SET state = :state, attempts = attempts + 1, lastAttemptMillis = :now,
        lastError = :error, nextAttemptMillis = :nextAttempt
    WHERE entityId = :entityId
    """,
  )
  suspend fun recordFailure(
    entityId: String,
    state: String,
    now: Long,
    error: String?,
    nextAttempt: Long,
  )

  @Query("SELECT count(*) FROM sync_outbox WHERE state = 'pending'")
  fun pendingCount(): Flow<Int>

  /**
   * Entries that failed too many times.
   *
   * A visible, inspectable state a manager can see and a support engineer can
   * read, rather than a silent hole in the day's numbers.
   */
  @Query("SELECT * FROM sync_outbox WHERE state = 'dead' ORDER BY createdAtMillis")
  fun deadLetters(): Flow<List<OutboxEntity>>

  @Query("SELECT count(*) FROM sync_outbox WHERE state = 'dead'")
  fun deadCount(): Flow<Int>
}

@Dao
interface ConfigDao {
  @Query("SELECT * FROM register_config WHERE id = 1")
  fun observe(): Flow<RegisterConfigEntity?>

  @Query("SELECT * FROM register_config WHERE id = 1")
  suspend fun get(): RegisterConfigEntity?

  @Upsert suspend fun upsert(config: RegisterConfigEntity)

  /**
   * Claim the next receipt number.
   *
   * Returns the value it consumed, so two concurrent sales cannot be handed the
   * same one. Local and monotonic, which is what lets a receipt print with no
   * network: a global sequence would need a number server, and a number server
   * is a thing that can be unreachable while a customer waits.
   */
  @Transaction
  suspend fun claimSequence(): Long {
    val current = get()?.nextSequence ?: 1L
    bumpSequence(current + 1)
    return current
  }

  @Query("UPDATE register_config SET nextSequence = :next WHERE id = 1")
  suspend fun bumpSequence(next: Long)

  @Query("UPDATE register_config SET lastCatalogCursor = :cursor WHERE id = 1")
  suspend fun setCatalogCursor(cursor: String)

  @Query("UPDATE register_config SET clockOffsetMillis = :offset WHERE id = 1")
  suspend fun setClockOffset(offset: Long)
}

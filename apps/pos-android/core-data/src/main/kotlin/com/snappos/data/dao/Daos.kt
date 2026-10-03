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

/**
 * One row of the navigation index.
 *
 * Deliberately thin. The register rebuilds its brand and model tree whenever
 * the catalog changes, and that needs names and nothing else -- no price, no
 * stock, no compliance. Pulling whole variant rows for a five thousand SKU shop
 * to read four columns off each is work the till does not have time for.
 */
data class CatalogIndexRow(
  val id: String,
  /** Which product this flavor belongs to: a product with flavors is one model folder. */
  val productId: String,
  val productName: String,
  val variantName: String?,
  val brandId: String?,
  val brandName: String?,
  val categoryId: String?,
  val sortOrder: Int,
  /** Carried so a brand or model folder can wear one of its own products as its cover. */
  val imageUrl: String?,
  /**
   * Name, SKU, PLU, brand and barcodes, lowercased at sync. Carried so search
   * can run over the same in-memory tree the folders are drawn from -- see
   * `ProductSearchIndex` for why it no longer runs in SQL.
   */
  val searchText: String,
)

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
   * Search, the old way: one contiguous substring.
   *
   * No longer what the register searches with -- `ProductSearchIndex` matches
   * each typed word on its own, which a single `LIKE` cannot express. Kept as
   * the fallback for the moment before the catalog tree has been built, so a
   * search typed in the first second after launch still finds something.
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

  /**
   * Products in a category, including everything beneath it.
   *
   * Matching `categoryId` exactly was wrong: variants are assigned to leaf
   * categories, so tapping a department like "Vapes" returned nothing at all
   * while every vape sat one level down in "vapes.disposable". The materialized
   * path makes the descendant test a prefix comparison, which the
   * `categories_prefix_idx` equivalent on device serves directly.
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
    WHERE v.status = 'active'
      AND (:categoryId IS NULL OR v.categoryId IN (
            SELECT c.id FROM categories c
            WHERE c.id = :categoryId
               OR c.path LIKE (SELECT p2.path FROM categories p2 WHERE p2.id = :categoryId) || '.%'
          ))
    ORDER BY v.productName, v.sortOrder
    LIMIT :limit
    """,
  )
  suspend fun byCategory(categoryId: String?, now: Long, limit: Int = 200): List<ScannedItem>

  /**
   * Everything sellable, names only, as a Flow.
   *
   * A Flow rather than a one-shot read so the tree repairs itself the moment a
   * sync lands. A cashier who watches a new line appear mid-shift without
   * touching anything trusts the till; one who has to be told to restart it
   * does not.
   */
  @Query(
    """
    SELECT id, productId, productName, variantName, brandId, brandName, categoryId, sortOrder, imageUrl, searchText
    FROM variants
    WHERE status = 'active'
    ORDER BY brandName, productName, sortOrder
    """,
  )
  fun catalogIndex(): Flow<List<CatalogIndexRow>>

  /**
   * Full rows for an explicit set of variants, for the tiles of one model line.
   *
   * Ordered by the caller's list rather than by name: the navigation tree
   * already decided what order flavours go in, and re-sorting here would
   * silently disagree with it.
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
    WHERE v.status = 'active' AND v.id IN (:ids)
    """,
  )
  suspend fun byIds(ids: List<String>, now: Long): List<ScannedItem>

  @Query("SELECT * FROM categories ORDER BY sortOrder, name")
  fun categories(): Flow<List<CategoryEntity>>

  @Upsert suspend fun upsertVariants(variants: List<VariantEntity>)

  @Upsert suspend fun upsertBarcodes(barcodes: List<BarcodeEntity>)

  @Upsert suspend fun upsertPrices(prices: List<PriceEntity>)

  @Upsert suspend fun upsertCategories(categories: List<CategoryEntity>)

  @Upsert suspend fun upsertInventory(levels: List<InventoryEntity>)

  @Query("DELETE FROM barcodes") suspend fun clearBarcodes()
  @Query("DELETE FROM variants") suspend fun clearVariants()
  @Query("DELETE FROM categories") suspend fun clearCategories()
  @Query("DELETE FROM prices") suspend fun clearPrices()
  @Query("DELETE FROM inventory") suspend fun clearInventory()

  @Query("SELECT count(*) FROM variants")
  suspend fun variantCount(): Int
}

@Dao
interface EmployeeDao {
  /** A one-shot read, for approval checks that must not observe a Flow. */
  @Query("SELECT * FROM employees WHERE status = 'active' ORDER BY displayName")
  suspend fun activeOnce(): List<EmployeeEntity>

  @Query("SELECT * FROM employees WHERE status = 'active' ORDER BY displayName")
  fun active(): Flow<List<EmployeeEntity>>

  /**
   * Every employee row, active or not.
   *
   * Only ever used to explain an empty roster. "No staff on this register" and
   * "every member of staff on this register is inactive" look identical at the
   * till and need completely different remedies, so the screen has to be able
   * to tell them apart.
   */
  @Query("SELECT count(*) FROM employees")
  fun countAll(): Flow<Int>

  /**
   * How many can actually sign in.
   *
   * Counted rather than inferred from the roster list being empty. The screen
   * used to conclude "every member of staff is inactive" from the total alone,
   * which is a different question and has a different remedy.
   */
  @Query("SELECT count(*) FROM employees WHERE status = 'active'")
  fun countActive(): Flow<Int>

  @Query("SELECT * FROM employees WHERE id = :id")
  suspend fun byId(id: String): EmployeeEntity?

  @Query("SELECT * FROM employees WHERE employeeCode = :code AND status = 'active'")
  suspend fun byCode(code: String): EmployeeEntity?

  @Upsert suspend fun upsert(employees: List<EmployeeEntity>)

  @Query("DELETE FROM employees") suspend fun clear()

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

  /**
   * One day's sales, newest first.
   *
   * Half open on purpose: `from` is midnight and `to` is the next midnight,
   * so a sale rung at 23:59:59.999 belongs to the day it was rung on and
   * nothing lands in two days at once.
   *
   * Parked baskets are left out. They are not receipts, nobody was handed
   * one, and offering to reprint something that was never sold is a way to
   * hand a customer paper for a sale that did not happen.
   */
  @Query(
    """
    SELECT * FROM sales
    WHERE completedAtMillis >= :from AND completedAtMillis < :to
      AND status != 'parked'
    ORDER BY completedAtMillis DESC
    LIMIT :limit
    """,
  )
  suspend fun onDay(from: Long, to: Long, limit: Int = 300): List<SaleEntity>

  /** Receipt number lookup, for when the customer has the slip in their hand. */
  @Query("SELECT * FROM sales WHERE UPPER(receiptNo) = UPPER(:receiptNo) LIMIT 1")
  suspend fun byReceiptNo(receiptNo: String): SaleEntity?

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

  /**
   * Put every failed entry back in the queue, from its first attempt.
   *
   * For after a person has fixed what made them fail, or wants the server's
   * reason again. Retrying cannot double anything: the entity id is the
   * idempotency key, so one that did land after all comes back a duplicate.
   */
  @Query("UPDATE sync_outbox SET state = 'pending', attempts = 0, nextAttemptMillis = :now WHERE state = 'dead'")
  suspend fun retryDead(now: Long): Int
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

  @Query("UPDATE register_config SET cashierUserId = :userId WHERE id = 1")
  suspend fun setCashier(userId: String)
}

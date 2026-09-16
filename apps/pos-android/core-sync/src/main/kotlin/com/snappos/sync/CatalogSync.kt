package com.snappos.sync

import android.util.Log
import androidx.room.withTransaction
import com.snappos.data.SnapPosDatabase
import com.snappos.data.dao.CatalogDao
import com.snappos.data.dao.ConfigDao
import com.snappos.data.dao.EmployeeDao
import com.snappos.data.entities.BarcodeEntity
import com.snappos.data.entities.CategoryEntity
import com.snappos.data.entities.InventoryEntity
import com.snappos.data.entities.PriceEntity
import com.snappos.data.entities.VariantEntity
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Pulling the catalog down.
 *
 * The register replicates everything it needs to sell: variants, barcodes,
 * effective dated prices, categories, a stock snapshot and the tax rate. After
 * this runs the device can ring sales with the network unplugged, which is the
 * whole point.
 *
 * **Server wins on catalog.** These are projections of server state, so a
 * conflict is not a conflict: the local copy is overwritten. That is the
 * opposite of how sales are treated, where the register is the authority until
 * the server acknowledges, and the difference is deliberate — losing a catalog
 * row costs a re-sync, losing a sale costs money.
 */
@Singleton
class CatalogSync @Inject constructor(
  private val api: SnapPosApi,
  private val catalog: CatalogDao,
  private val employees: EmployeeDao,
  private val config: ConfigDao,
  private val database: SnapPosDatabase,
) {

  data class Result(
    val variants: Int = 0,
    val barcodes: Int = 0,
    val prices: Int = 0,
    val categories: Int = 0,
    val employees: Int = 0,
    val failure: String? = null,
    /** The server had nothing new, so nothing was transferred or written. */
    val unchanged: Boolean = false,
  ) {
    val ok: Boolean get() = failure == null
  }

  /**
   * Ask for an atomic projection delta, and only pull scopes that changed.
   *
   * A register polls all day and the answer is almost always "nothing". Pulling
   * the whole catalog to discover that is the cost this avoids: with a few
   * thousand SKUs it is the largest thing the device transfers, repeated every
   * fifteen minutes, to arrive back where it started.
   *
   * The cursor is `change_log.id`, held by the server below any change whose
   * transaction might still be in flight. That means a change can arrive twice,
   * which is harmless — applying it is idempotent — and none is ever missed,
   * which is the property that matters.
   *
   * Detection, projection reads and the returned cursor happen in one server
   * transaction. Keeping those together prevents a category commit between a
   * feed request and a price-only fetch from being skipped by a global cursor.
   */
  suspend fun pull(): Result {
    val registerConfig = config.get() ?: return Result(failure = "device not claimed")

    // "0" is what provisioning seeds, and blank is a device that has never
    // completed a pull. Either way there is nothing to be incremental against,
    // so the first pull is always the full bootstrap.
    val cursor = registerConfig.lastCatalogCursor.trim()
    val response = try {
      api.catalog(registerConfig.storeId, cursor.takeIf { it.isNotBlank() && it != "0" })
    } catch (e: Exception) {
      Log.i(TAG, "catalog pull could not reach the server: ${e.message}")
      return Result(failure = e.message ?: "network unavailable")
    }

    if (!response.isSuccessful) {
      return Result(failure = "HTTP ${response.code()}")
    }
    var snapshot = response.body() ?: return Result(failure = "empty response")
    val knownScopes = setOf("catalog", "prices", "tax", "employees", "inventory")
    if (snapshot.included_scopes.any { it !in knownScopes }) {
      Log.w(TAG, "unsupported delta scope; requesting a complete snapshot")
      val fallback = try { api.catalog(registerConfig.storeId) } catch (e: Exception) {
        return Result(failure = e.message ?: "network unavailable")
      }
      if (!fallback.isSuccessful) return Result(failure = "HTTP ${fallback.code()}")
      snapshot = fallback.body() ?: return Result(failure = "empty fallback response")
    }
    val scopes = snapshot.included_scopes.toSet()
    if (scopes.isEmpty()) {
      config.setCatalogCursor(snapshot.cursor)
      Log.i(TAG, "catalog current at cursor ${snapshot.cursor}; nothing pulled")
      return Result(unchanged = true)
    }

    val categoryRows =
      snapshot.categories.map {
        CategoryEntity(
          id = it.id,
          parentId = it.parent_id,
          name = it.name,
          path = it.path,
          depth = it.depth,
          sortOrder = it.sort_order,
          tileColor = it.tile_color,
          isDepartment = it.is_department,
        )
      }

    // Barcodes are needed to build each variant's search text, so they are
    // grouped first. Search matching a barcode matters more than it sounds:
    // a cashier with an unreadable label types the digits they can make out.
    val barcodesByVariant = snapshot.barcodes.groupBy { it.variant_id }
    val now = System.currentTimeMillis()

    val variantRows =
      snapshot.variants.map { v ->
        VariantEntity(
          id = v.id,
          productId = v.product_id,
          productName = v.product_name,
          variantName = v.variant_name,
          sku = v.sku,
          plu = v.plu,
          brandId = v.brand_id,
          brandName = v.brand_name,
          categoryId = v.category_id,
          taxCategoryId = v.tax_category_id,
          cost = v.cost,
          caseQuantity = v.case_quantity,
          imageUrl = v.image_url,
          sortOrder = v.sort_order,
          isDefault = v.is_default,
          status = v.status,
          minimumAge = v.minimum_age,
          idScanRequired = v.id_scan_required,
          regulatedClass = v.regulated_class,
          // Denormalized and lowercased at write time, so the query does not
          // have to lower a column and lose the index.
          searchText = buildList {
            add(v.product_name)
            v.variant_name?.let(::add)
            add(v.sku)
            v.plu?.let(::add)
            v.brand_name?.let(::add)
            barcodesByVariant[v.id]?.forEach { add(it.barcode) }
          }.joinToString(" ").lowercase(),
          updatedAt = now,
        )
      }

    val barcodeRows =
      snapshot.barcodes.map {
        BarcodeEntity(
          barcode = it.barcode,
          variantId = it.variant_id,
          kind = it.kind,
          units = it.units,
          isPrimary = it.is_primary,
        )
      }

    val priceRows =
      snapshot.prices.map {
        PriceEntity(
          id = it.id,
          variantId = it.variant_id,
          kind = it.kind,
          priceMinor = it.price_minor.toLong(),
          effectiveFrom = it.effective_from.toEpochMillisOrZero(),
          effectiveTo = it.effective_to?.toEpochMillisOrZero(),
        )
      }

    val inventoryRows =
      snapshot.inventory.map {
        InventoryEntity(
          variantId = it.variant_id,
          onHand = it.on_hand,
          available = it.available,
          updatedAt = now,
        )
      }

    // One rate for now. Per category rates are Phase 4, when the tax engine
    // grows past a single store with a single rate.
    val employeeRows =
      snapshot.employees.map {
        com.snappos.data.entities.EmployeeEntity(
          id = it.id,
          displayName = it.display_name,
          employeeCode = it.employee_code,
          pinHash = it.pin_hash,
          permissions = it.permissions.joinToString(","),
          status = it.status,
        )
      }

    // Projection replacement and cursor advancement are one local commit. A
    // crash can leave the old projection and old cursor, or the new projection
    // and new cursor, but never a cursor claiming rows Room did not apply.
    database.withTransaction {
      if ("catalog" in scopes) {
        catalog.clearBarcodes()
        catalog.clearVariants()
        catalog.clearCategories()
        catalog.upsertCategories(categoryRows)
        catalog.upsertVariants(variantRows)
        catalog.upsertBarcodes(barcodeRows)
      }
      if ("prices" in scopes) {
        catalog.clearPrices()
        catalog.upsertPrices(priceRows)
      }
      if ("inventory" in scopes) {
        catalog.clearInventory()
        catalog.upsertInventory(inventoryRows)
      }
      if ("employees" in scopes) {
        employees.clear()
        employees.upsert(employeeRows)
      }
      if ("tax" in scopes) {
        snapshot.tax_rates.firstOrNull()?.let { rate ->
          config.get()?.let { current -> config.upsert(current.copy(taxRate = rate.rate)) }
        }
      }
      config.setCatalogCursor(snapshot.cursor)
    }

    Log.i(
      TAG,
      "catalog: ${snapshot.variants.size} variants, ${snapshot.barcodes.size} barcodes, " +
        "${snapshot.employees.size} employees, cursor ${snapshot.cursor}",
    )

    return Result(
      variants = snapshot.variants.size,
      barcodes = snapshot.barcodes.size,
      prices = snapshot.prices.size,
      categories = snapshot.categories.size,
      employees = snapshot.employees.size,
    )
  }

  private companion object {
    const val TAG = "CatalogSync"
  }
}

/**
 * Server timestamps are ISO 8601 with an offset; Room stores epoch millis.
 *
 * An unparseable value becomes 0 rather than throwing. For `effective_from`
 * that means "already in effect", which is the safe direction: a price that
 * applies when it should not is visible and correctable, while a price that
 * silently fails to apply looks like the product simply has no price and the
 * register refuses to sell it.
 */
private fun String.toEpochMillisOrZero(): Long =
  runCatching { Instant.parse(this).toEpochMilli() }
    .getOrElse {
      runCatching { java.time.OffsetDateTime.parse(this).toInstant().toEpochMilli() }
        .getOrDefault(0L)
    }

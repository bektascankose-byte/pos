package com.snappos.sync

import android.util.Log
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
   * Ask what changed, and only pull if something did.
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
   * **This is incremental detection, not yet incremental application.** When
   * something has changed the register still pulls the full snapshot rather
   * than fetching the individual rows named in the feed. Per-entity fetching
   * needs endpoints that return a row in the register's own projection shape,
   * and those do not exist yet. The win banked here is the idle case, which is
   * almost all of them.
   */
  suspend fun pull(): Result {
    val registerConfig = config.get() ?: return Result(failure = "device not claimed")

    // "0" is what provisioning seeds, and blank is a device that has never
    // completed a pull. Either way there is nothing to be incremental against,
    // so the first pull is always the full bootstrap.
    val cursor = registerConfig.lastCatalogCursor.trim()
    if (cursor.isNotBlank() && cursor != "0") {
      val changed = try {
        api.changes(since = cursor, storeId = registerConfig.storeId)
      } catch (e: Exception) {
        Log.i(TAG, "change feed could not reach the server: ${e.message}")
        return Result(failure = e.message ?: "network unavailable")
      }

      // A feed that cannot be read is not evidence that nothing changed, so a
      // failure here falls through to a full pull rather than concluding the
      // catalog is current.
      if (changed.isSuccessful) {
        val body = changed.body()
        if (body != null && body.changes.isEmpty()) {
          Log.i(TAG, "catalog current at cursor $cursor; nothing pulled")
          return Result(unchanged = true)
        }
        Log.i(TAG, "changes since $cursor; refreshing the catalog")
      }
    }

    val response = try {
      api.catalog(registerConfig.storeId)
    } catch (e: Exception) {
      Log.i(TAG, "catalog pull could not reach the server: ${e.message}")
      return Result(failure = e.message ?: "network unavailable")
    }

    if (!response.isSuccessful) {
      return Result(failure = "HTTP ${response.code()}")
    }
    val snapshot = response.body() ?: return Result(failure = "empty response")

    catalog.upsertCategories(
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
      },
    )

    // Barcodes are needed to build each variant's search text, so they are
    // grouped first. Search matching a barcode matters more than it sounds:
    // a cashier with an unreadable label types the digits they can make out.
    val barcodesByVariant = snapshot.barcodes.groupBy { it.variant_id }
    val now = System.currentTimeMillis()

    catalog.upsertVariants(
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
          imageUrl = null,
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
      },
    )

    catalog.upsertBarcodes(
      snapshot.barcodes.map {
        BarcodeEntity(
          barcode = it.barcode,
          variantId = it.variant_id,
          kind = it.kind,
          units = it.units,
          isPrimary = it.is_primary,
        )
      },
    )

    catalog.upsertPrices(
      snapshot.prices.map {
        PriceEntity(
          id = it.id,
          variantId = it.variant_id,
          kind = it.kind,
          priceMinor = it.price_minor.toLong(),
          effectiveFrom = it.effective_from.toEpochMillisOrZero(),
          effectiveTo = it.effective_to?.toEpochMillisOrZero(),
        )
      },
    )

    catalog.upsertInventory(
      snapshot.inventory.map {
        InventoryEntity(
          variantId = it.variant_id,
          onHand = it.on_hand,
          available = it.available,
          updatedAt = now,
        )
      },
    )

    // One rate for now. Per category rates are Phase 4, when the tax engine
    // grows past a single store with a single rate.
    snapshot.tax_rates.firstOrNull()?.let { rate ->
      config.get()?.let { current -> config.upsert(current.copy(taxRate = rate.rate)) }
    }

    // Staff who may unlock this register. Replicated so a shift can start with
    // no network, which is when shifts usually start.
    employees.upsert(
      snapshot.employees.map {
        com.snappos.data.entities.EmployeeEntity(
          id = it.id,
          displayName = it.display_name,
          employeeCode = it.employee_code,
          pinHash = it.pin_hash,
          permissions = it.permissions.joinToString(","),
          status = it.status,
        )
      },
    )

    config.setCatalogCursor(snapshot.cursor)

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

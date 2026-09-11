package com.snappos.data

import com.snappos.data.dao.CatalogDao
import com.snappos.data.dao.ConfigDao
import com.snappos.data.dao.ScannedItem
import com.snappos.data.entities.CategoryEntity
import com.snappos.domain.Money
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * A product resolved from a scan or a search, in the shape the cart wants.
 *
 * `price` is nullable on purpose. A variant with no active price is a real
 * situation — a product received but never priced — and the register has to
 * refuse it clearly rather than sell it at zero. Selling at a price nobody set
 * is how a shop loses money quietly.
 */
data class ResolvedProduct(
  val variantId: String,
  val productName: String,
  val variantName: String?,
  val sku: String,
  val price: Money?,
  val cost: String,
  val units: Int,
  val onHand: String?,
  val minimumAge: Int?,
  val idScanRequired: Boolean,
) {
  val displayName: String get() = productName
  val inStock: Boolean get() = (onHand?.toDoubleOrNull() ?: 0.0) > 0.0
}

@Singleton
class CatalogRepository @Inject constructor(
  private val catalog: CatalogDao,
  private val config: ConfigDao,
) {

  fun categories(): Flow<List<CategoryEntity>> = catalog.categories()

  suspend fun isEmpty(): Boolean = catalog.variantCount() == 0

  /**
   * Resolve a scanned barcode.
   *
   * Returns null rather than throwing when nothing matches: an unknown barcode
   * is an ordinary event at a counter (a new product, a damaged label, a
   * customer's loyalty card) and the register shows a short message rather than
   * treating it as an error.
   */
  suspend fun scan(barcode: String): ResolvedProduct? =
    catalog.resolveBarcode(barcode.trim(), System.currentTimeMillis())?.toResolved()

  suspend fun search(query: String, limit: Int = 50): List<ResolvedProduct> =
    if (query.isBlank()) emptyList()
    else catalog.search(query.trim(), System.currentTimeMillis(), limit).map { it.toResolved() }

  suspend fun byCategory(categoryId: String?, limit: Int = 200): List<ResolvedProduct> =
    catalog.byCategory(categoryId, System.currentTimeMillis(), limit).map { it.toResolved() }

  /** The store's tax rate, as a decimal string. Never a float. */
  suspend fun taxRate(): String = config.get()?.taxRate ?: "0"

  private fun ScannedItem.toResolved() = ResolvedProduct(
    variantId = variant.id,
    productName = variant.productName,
    variantName = variant.variantName,
    sku = variant.sku,
    price = priceMinor?.let { Money.ofMinor(it) },
    cost = variant.cost,
    // A case barcode adds a case. Fractional scan units would mean a weighed
    // item, which scans by weight rather than by barcode, so whole units here.
    units = scanUnits.toDoubleOrNull()?.toInt() ?: 1,
    onHand = onHand,
    minimumAge = variant.minimumAge,
    idScanRequired = variant.idScanRequired,
  )
}

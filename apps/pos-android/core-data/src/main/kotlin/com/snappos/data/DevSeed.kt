package com.snappos.data

import com.snappos.data.dao.CatalogDao
import com.snappos.data.dao.ConfigDao
import com.snappos.data.entities.BarcodeEntity
import com.snappos.data.entities.CategoryEntity
import com.snappos.data.entities.InventoryEntity
import com.snappos.data.entities.PriceEntity
import com.snappos.data.entities.RegisterConfigEntity
import com.snappos.data.entities.VariantEntity
import com.snappos.domain.Uuid7
import javax.inject.Inject
import javax.inject.Singleton

/**
 * A local catalog, for development only.
 *
 * The register's catalog normally arrives from `GET /v1/sync/changes` after the
 * device is claimed. That is not built yet, and until it is there is no way to
 * exercise scan-to-cart on a real device at all.
 *
 * So this writes the same six products the server seed writes, matching SKUs,
 * barcodes and prices, which means a sale rung here uploads cleanly against the
 * server seed once the sync client exists.
 *
 * **It is not a substitute for sync and must not become one.** It runs only
 * when the catalog is empty and only in debug builds. The moment the sync
 * client lands this becomes dead code and should be deleted rather than kept
 * "just for testing", because a second source of catalog truth is exactly how
 * a register ends up disagreeing with the shop about what things cost.
 */
@Singleton
class DevSeed @Inject constructor(
  private val catalog: CatalogDao,
  private val config: ConfigDao,
) {

  suspend fun seedIfEmpty(storeId: String = DEV_STORE_ID) {
    if (catalog.variantCount() > 0) return

    config.upsert(
      RegisterConfigEntity(
        orgId = DEV_ORG_ID,
        storeId = storeId,
        storeCode = "HH01",
        storeName = "Harker Heights",
        registerId = DEV_REGISTER_ID,
        registerCode = "R1",
        deviceId = Uuid7.generate(),
        apiBaseUrl = "http://10.0.2.2:3000",
        nextSequence = 1,
        // Texas state plus local for Harker Heights. A development value, not
        // tax advice: real rates are configured per store before go live.
        taxRate = "0.0825",
        lastCatalogCursor = "0",
        clockOffsetMillis = 0,
      ),
    )

    catalog.upsertCategories(
      listOf(
        CategoryEntity("cat-vapes", null, "Vapes", "vapes", 0, 0, null, true),
        CategoryEntity("cat-disposable", "cat-vapes", "Disposable Vapes", "vapes.disposable", 1, 0, null, false),
        CategoryEntity("cat-tobacco", null, "Tobacco", "tobacco", 0, 1, null, true),
        CategoryEntity("cat-cigars", "cat-tobacco", "Cigars & Wraps", "tobacco.cigars", 1, 0, null, false),
        CategoryEntity("cat-pouches", "cat-tobacco", "Nicotine Pouches", "tobacco.nicotine-pouches", 1, 1, null, false),
        CategoryEntity("cat-accessories", null, "Accessories", "accessories", 0, 2, null, true),
        CategoryEntity("cat-papers", "cat-accessories", "Rolling Papers", "accessories.papers", 1, 0, null, false),
        CategoryEntity("cat-drinks", null, "Drinks", "drinks", 0, 3, null, true),
      ),
    )

    val now = System.currentTimeMillis()
    val variants = mutableListOf<VariantEntity>()
    val barcodes = mutableListOf<BarcodeEntity>()
    val prices = mutableListOf<PriceEntity>()
    val inventory = mutableListOf<InventoryEntity>()

    fun add(
      id: String,
      product: String,
      variantName: String?,
      sku: String,
      brand: String,
      categoryId: String,
      barcode: String,
      priceMinor: Long,
      cost: String,
      onHand: Int,
      minimumAge: Int? = null,
      regulatedClass: String? = null,
      sortOrder: Int = 0,
    ) {
      variants += VariantEntity(
        id = id,
        productId = "prod-${sku.substringBefore('-')}",
        productName = product,
        variantName = variantName,
        sku = sku,
        plu = null,
        brandId = "brand-${brand.lowercase().replace(' ', '-')}",
        brandName = brand,
        categoryId = categoryId,
        taxCategoryId = "tax-standard",
        cost = cost,
        caseQuantity = 5,
        imageUrl = null,
        sortOrder = sortOrder,
        isDefault = sortOrder == 0,
        status = "active",
        minimumAge = minimumAge,
        idScanRequired = minimumAge != null,
        regulatedClass = regulatedClass,
        // Denormalized so search never joins. Lowercased at write time so the
        // query does not have to lower a column and lose the index.
        searchText = listOfNotNull(product, variantName, sku, brand, barcode)
          .joinToString(" ").lowercase(),
        updatedAt = now,
      )
      barcodes += BarcodeEntity(barcode, id, "upc", "1", true)
      prices += PriceEntity("price-$id", id, "regular", priceMinor, 0, null)
      inventory += InventoryEntity(id, onHand.toString(), onHand.toString(), now)
    }

    val ends = 21 to "ends"

    add("v-gb-mm", "Geek Bar Pulse X", "Miami Mint", "GB-PULSEX-MM", "Geek Bar",
      "cat-disposable", "840216300101", 2499, "9.850000", 12, ends.first, ends.second, 0)
    add("v-gb-br", "Geek Bar Pulse X", "Blue Razz Ice", "GB-PULSEX-BR", "Geek Bar",
      "cat-disposable", "840216300118", 2499, "9.850000", 18, ends.first, ends.second, 1)
    add("v-gb-sb", "Geek Bar Pulse X", "Strawberry Banana", "GB-PULSEX-SB", "Geek Bar",
      "cat-disposable", "840216300125", 2499, "9.850000", 7, ends.first, ends.second, 2)
    // Deliberately zero: the register, the reorder report and the storefront
    // all need an out of stock variant to develop against on day one.
    add("v-gb-wi", "Geek Bar Pulse X", "Watermelon Ice", "GB-PULSEX-WI", "Geek Bar",
      "cat-disposable", "840216300132", 2499, "9.850000", 0, ends.first, ends.second, 3)

    add("v-lm-bb", "Lost Mary BM6000", "Blueberry Ice", "LM-BM6000-BB", "Lost Mary",
      "cat-disposable", "810082310014", 1999, "7.900000", 22, ends.first, ends.second, 0)
    add("v-lm-pm", "Lost Mary BM6000", "Pineapple Mango", "LM-BM6000-PM", "Lost Mary",
      "cat-disposable", "810082310021", 1999, "7.900000", 9, ends.first, ends.second, 1)

    add("v-bw-hb", "Backwoods Cigars 5pk", "Honey Berry", "BW-HONEY-5", "Backwoods",
      "cat-cigars", "027200003018", 649, "3.100000", 40, 21, "cigar", 0)
    add("v-bw-og", "Backwoods Cigars 5pk", "Original", "BW-ORIG-5", "Backwoods",
      "cat-cigars", "027200003001", 649, "3.100000", 35, 21, "cigar", 1)

    add("v-zyn-cm", "Zyn Nicotine Pouches", "Cool Mint 6mg", "ZYN-COOL-6", "Zyn",
      "cat-pouches", "300060000016", 599, "3.450000", 30, 21, "pouch", 0)
    add("v-zyn-ct", "Zyn Nicotine Pouches", "Citrus 3mg", "ZYN-CITR-3", "Zyn",
      "cat-pouches", "300060000023", 599, "3.450000", 25, 21, "pouch", 1)

    // Not age restricted. The compliance path must be able to say "no prompt"
    // as confidently as it says "prompt", and a catalog of only regulated SKUs
    // would never exercise that.
    add("v-mon-ultra", "Monster Energy Ultra", null, "MON-ULTRA-16", "Monster",
      "cat-drinks", "070847811169", 399, "1.550000", 48)
    add("v-raw-kss", "RAW Classic King Size Slim", null, "RAW-KSS", "RAW",
      "cat-papers", "716165174233", 299, "1.100000", 60)

    catalog.upsertVariants(variants)
    catalog.upsertBarcodes(barcodes)
    catalog.upsertPrices(prices)
    catalog.upsertInventory(inventory)
  }

  companion object {
    // Placeholders until the device is claimed by a real register. They are
    // syntactically valid uuids so nothing downstream has to special case them.
    const val DEV_ORG_ID = "00000000-0000-4000-8000-000000000001"
    const val DEV_STORE_ID = "00000000-0000-4000-8000-000000000002"
    const val DEV_REGISTER_ID = "00000000-0000-4000-8000-000000000003"
    const val DEV_CASHIER_ID = "00000000-0000-4000-8000-000000000004"
  }
}

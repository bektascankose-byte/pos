package com.snappos.data

import com.snappos.data.dao.CatalogDao
import com.snappos.data.dao.CatalogIndexRow
import com.snappos.data.dao.ConfigDao
import com.snappos.data.dao.ScannedItem
import com.snappos.data.entities.CategoryEntity
import com.snappos.domain.Money
import com.snappos.domain.NamedItem
import com.snappos.domain.ProductNameParts
import com.snappos.domain.ProductSearchIndex
import com.snappos.domain.SearchDocument
import com.snappos.domain.taxonomize
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
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
  val brandName: String?,
  val sku: String,
  val price: Money?,
  val cost: String,
  val units: Int,
  val onHand: String?,
  val minimumAge: Int?,
  val idScanRequired: Boolean,
  /** Server-relative path to this item's photo, or null. Joined to the base URL by whatever draws it. */
  val imageUrl: String?,
) {
  val displayName: String get() = productName

  /**
   * What to put on a tile, with the part every neighbouring tile shares taken
   * off the front.
   *
   * Some suppliers name each flavour as its own product -- "FOGER SwitchPro
   * Disposable Pod Blue Razz Ice" -- so forty-eight tiles begin with the same
   * twenty-eight characters and the flavour, the only part that tells them
   * apart, is the part a narrow tile cuts off. Every tile then reads "FOGER
   * SwitchPro Di..." and a cashier cannot pick one without opening it.
   *
   * Dropping the brand is the safe half of the problem: the brand is shown on
   * its own line anyway, so nothing is lost. Only a whole leading word is
   * removed, so a brand that is genuinely part of the name ("Backwoods Cigars
   * 5pk" for brand "Backwoods") keeps reading correctly -- it loses "Backwoods"
   * and keeps "Cigars 5pk", which is what the shelf calls it.
   */
  val tileLabel: String
    get() {
      val brand = brandName?.trim().orEmpty()
      if (brand.isEmpty()) return productName
      val name = productName.trim()
      if (!name.startsWith(brand, ignoreCase = true)) return productName
      val rest = name.drop(brand.length).trimStart(' ', '-', ':', '\u2013')
      // Never leave a tile with nothing on it: a product named only for its
      // brand keeps its name.
      return rest.ifBlank { productName }
    }

  val inStock: Boolean get() = (onHand?.toDoubleOrNull() ?: 0.0) > 0.0
}


/**
 * One model line: the thing a cashier taps to see flavours.
 *
 * Holds variant ids rather than whole products. The tree is rebuilt on every
 * catalog change and a shop carries thousands of SKUs; keeping prices and
 * stock in it would mean re-reading the whole catalog to redraw a menu.
 */
data class LineNode(
  val id: String,
  val name: String,
  val brandId: String?,
  val brandName: String?,
  val categoryIds: Set<String>,
  val variantIds: List<String>,
  /**
   * A photo from inside this folder, so the folder is recognisable rather than
   * a word in a box. The first of its products that has one: a model line's
   * devices differ by colour, and any of them says what the line looks like.
   */
  val coverImageUrl: String? = null,
)

data class BrandNode(
  val id: String,
  val name: String,
  val categoryIds: Set<String>,
  val lines: List<LineNode>,
) {
  val itemCount: Int get() = lines.sumOf { it.variantIds.size }

  /** The brand folder's cover, taken from the first of its lines that has one. */
  val coverImageUrl: String? get() = lines.firstNotNullOfOrNull { it.coverImageUrl }

  /**
   * Whether opening this brand should show model folders or go straight to the
   * products.
   *
   * A brand with one model line has nothing to choose between, and making a
   * cashier tap through a folder containing exactly one folder is a tap that
   * buys them nothing.
   */
  val hasModelChoice: Boolean get() = lines.size > 1
}

/**
 * The register's menu, and the names that go with it.
 *
 * `parts` is here rather than on each product because the split can only be
 * worked out across a whole brand at once -- see `taxonomize`. Every place that
 * shows a product name reads it from this one map, so a tile, a cart row and a
 * printed receipt cannot disagree about what something is called.
 */
data class CatalogNavigation(
  val brands: List<BrandNode> = emptyList(),
  val parts: Map<String, ProductNameParts> = emptyMap(),
  /**
   * Search over the same tree, built alongside it.
   *
   * Built here rather than on each keystroke because the words it matches on
   * are the taxonomy's -- the brand a blank catalog field was given back, the
   * model line and flavour split off a welded name -- and those only exist
   * once `taxonomize` has run. A search that could not see them would find
   * "Foger" products the folders call Foger only when the catalog happened to
   * say so.
   */
  val search: ProductSearchIndex = ProductSearchIndex.EMPTY,
  /**
   * Each category with every category beneath it, itself included. See
   * `categorySubtrees`.
   */
  val subtree: Map<String, Set<String>> = emptyMap(),
) {
  /**
   * A category and everything filed beneath it. One the tree has not seen
   * (the categories have not synced yet) stands for itself alone, which is
   * what this matched before departments looked beneath themselves.
   */
  private fun within(categoryId: String): Set<String> = subtree[categoryId] ?: setOf(categoryId)

  fun brandsIn(categoryId: String?): List<BrandNode> {
    if (categoryId == null) return brands
    val ids = within(categoryId)
    return brands.filter { brand -> brand.categoryIds.any { it in ids } }
  }

  fun linesIn(brandId: String?, categoryId: String?): List<LineNode> {
    val ids = categoryId?.let(::within)
    return brands.filter { brandId == null || it.id == brandId }
      .flatMap { it.lines }
      .filter { line -> ids == null || line.categoryIds.any { it in ids } }
  }

  fun line(id: String?): LineNode? =
    if (id == null) null else brands.firstNotNullOfOrNull { b -> b.lines.firstOrNull { it.id == id } }

  /** The label for a cart row or a receipt, falling back to the raw name. */
  fun label(variantId: String, fallback: String): String = parts[variantId]?.label ?: fallback
}

@Singleton
class CatalogRepository @Inject constructor(
  private val catalog: CatalogDao,
  private val config: ConfigDao,
) {

  fun categories(): Flow<List<CategoryEntity>> = catalog.categories()

  /**
   * The brand and model tree, rebuilt whenever the catalog changes.
   *
   * Derived on device rather than sent down from the server on purpose. The
   * server has no more structure than the register does -- a supplier feed is
   * flat names -- so deriving it here means one implementation to be right
   * about, and a shop that adds a product line sees the menu reshape itself on
   * the next sync without anyone configuring anything.
   */
  fun navigation(): Flow<CatalogNavigation> =
    combine(catalog.catalogIndex(), catalog.categories(), ::buildNavigation)

  /** Full rows for one model line's variants, in the order the tree put them. */
  suspend fun byIds(ids: List<String>): List<ResolvedProduct> {
    if (ids.isEmpty()) return emptyList()
    val order = ids.withIndex().associate { (index, id) -> id to index }
    return catalog.byIds(ids, System.currentTimeMillis())
      .map { it.toResolved() }
      .sortedBy { order[it.variantId] ?: Int.MAX_VALUE }
  }

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

  /** What this register calls the shop, for the header and the idle screen. */
  suspend fun storeName(): String? = config.get()?.storeName?.takeIf { it.isNotBlank() }

  /** The store's tax rate, as a decimal string. Never a float. */
  suspend fun taxRate(): String = config.get()?.taxRate ?: "0"

  private fun buildNavigation(rows: List<CatalogIndexRow>, categories: List<CategoryEntity>): CatalogNavigation {
    val parts = taxonomize(
      rows.map { NamedItem(it.id, it.productName, it.variantName, it.brandName) },
    )

    // Grouped on the brand the taxonomy resolved, not the raw column, and on
    // the *name* rather than the id.
    //
    // The name, because a catalog that carries one brand under two ids -- which
    // happens whenever a feed is re-imported -- would otherwise show two
    // identical tabs side by side.
    //
    // The taxonomy's answer, because it is the one the tiles and the receipt
    // already use, and a tree that disagreed with the labels inside it would
    // file "FOGER SwitchPro Kit 30K" under Other while the tile above it read
    // Foger. It also recovers the products whose brand column was never filled
    // in: in this shop that is 88 of 152, and grouped by the raw column they
    // collapse into a single "Other" pile of eighty-eight, which is exactly
    // the flat list this navigation exists to replace.
    val brands = rows
      .groupBy { parts[it.id]?.brand ?: it.brandName?.trim()?.takeIf { name -> name.isNotEmpty() } }
      .map { (brandName, brandRows) ->
        val lines = brandRows
          .groupBy { parts[it.id]?.line?.takeIf { line -> line.isNotBlank() } }
          .map { (lineName, lineRows) ->
            val sorted = lineRows.sortedWith(
              compareBy({ it.sortOrder }, { parts[it.id]?.tileLabel ?: it.productName }),
            )
            LineNode(
              id = "${brandName ?: "~"}/${lineName ?: "~"}",
              // A line with no model of its own is the brand's own shelf, and
              // "Other" reads better on a tab than an empty string does.
              name = lineName ?: brandName ?: "Other",
              brandId = brandRows.firstNotNullOfOrNull { it.brandId },
              brandName = brandName,
              categoryIds = lineRows.mapNotNull { it.categoryId }.toSet(),
              variantIds = sorted.map { it.id },
              coverImageUrl = sorted.firstNotNullOfOrNull { it.imageUrl },
            )
          }
          .sortedWith(compareByDescending<LineNode> { it.variantIds.size }.thenBy { it.name })
        BrandNode(
          id = brandName ?: "~",
          name = brandName ?: "Other",
          categoryIds = brandRows.mapNotNull { it.categoryId }.toSet(),
          lines = lines,
        )
      }
      // Biggest brand first. A cashier's hand goes to the same place all shift,
      // and the shop's best seller earning the first tab is worth more than
      // alphabetical order is.
      .sortedWith(compareByDescending<BrandNode> { it.itemCount }.thenBy { it.name })

    // Documents in menu order -- biggest brand, then its biggest line, then the
    // line's own order -- so equally good matches arrive grouped the way the
    // folders are rather than in whatever order the rows were read.
    val byId = rows.associateBy { it.id }
    val documents = brands.flatMap { it.lines }.flatMap { it.variantIds }.mapNotNull { id ->
      val row = byId[id] ?: return@mapNotNull null
      val p = parts[id]
      SearchDocument.of(id, p?.brand, p?.line, p?.flavour, row.searchText)
    }

    return CatalogNavigation(
      brands = brands,
      parts = parts,
      search = ProductSearchIndex(documents),
      subtree = categorySubtrees(categories),
    )
  }

  private fun ScannedItem.toResolved() = ResolvedProduct(
    variantId = variant.id,
    productName = variant.productName,
    variantName = variant.variantName,
    brandName = variant.brandName,
    sku = variant.sku,
    price = priceMinor?.let { Money.ofMinor(it) },
    cost = variant.cost,
    // A case barcode adds a case. Fractional scan units would mean a weighed
    // item, which scans by weight rather than by barcode, so whole units here.
    units = scanUnits.toDoubleOrNull()?.toInt() ?: 1,
    onHand = onHand,
    minimumAge = variant.minimumAge,
    idScanRequired = variant.idScanRequired,
    imageUrl = variant.imageUrl,
  )
}

/**
 * Each category with every category beneath it, itself included.
 *
 * Products are filed under the most specific category -- every vape in this
 * shop sits in "Disposable Vapes", none directly in "Vapes" -- while the rail
 * shows only departments. Matching a department's own id exactly left every
 * department except Everything empty. The materialized path makes "beneath" a
 * prefix test, the same one `CatalogDao.byCategory` already uses; the dot is
 * part of the prefix so a sibling that merely starts the same ("vapes-kits")
 * is not taken for a child of "vapes".
 */
internal fun categorySubtrees(categories: List<CategoryEntity>): Map<String, Set<String>> =
  categories.associate { root ->
    root.id to categories
      .filter { it.id == root.id || it.path.startsWith(root.path + ".") }
      .map { it.id }
      .toSet()
  }

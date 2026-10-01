package com.snappos.data

import com.snappos.data.dao.CatalogIndexRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Brand, then model, then flavor, each A to Z, the way the shop asked for the
 * till's folders to read.
 */
class CatalogTreeTest {

  private fun row(
    id: String,
    productId: String,
    productName: String,
    variantName: String?,
    brandName: String?,
    brandId: String? = brandName?.let { "brand-$it" },
    sortOrder: Int = 0,
  ) = CatalogIndexRow(
    id = id,
    productId = productId,
    productName = productName,
    variantName = variantName,
    brandId = brandId,
    brandName = brandName,
    categoryId = "disposable",
    sortOrder = sortOrder,
    imageUrl = null,
    searchText = "$productName ${variantName.orEmpty()}".lowercase(),
  )

  // Out of order on purpose, sort orders included, so A to Z has work to do.
  private val rows = listOf(
    row("sp-3", "switchpro", "Foger SwitchPro Pods", "Strawnana Ice Cream", "Foger", sortOrder = 0),
    row("sp-1", "switchpro", "Foger SwitchPro Pods", "Berry Bliss", "Foger", sortOrder = 2),
    row("sp-2", "switchpro", "Foger SwitchPro Pods", "Mexico Mango", "Foger", sortOrder = 1),
    row("bit-1", "bit", "Foger Bit 35K", "Blue Razz Ice", "Foger"),
    row("kit-1", "kit", "Foger SwitchPro Kits", "Clear", "Foger"),
    row("cel-2", "celsius", "Celsius Sparkling 12oz", "Orange", "Celsius"),
    row("cel-1", "celsius", "Celsius Sparkling 12oz", "Kiwi Guava", "Celsius"),
    row("loose", "loose", "Mystery Lighter", null, null, brandId = null),
  )

  private val tree = buildCatalogNavigation(rows, emptyList(), emptyList())

  @Test
  fun `brands read A to Z, with the unbranded shelf last`() {
    assertEquals(listOf("Celsius", "Foger", "Other"), tree.brands.map { it.name })
  }

  @Test
  fun `each product with flavors is its own model folder, A to Z`() {
    val foger = tree.brands.first { it.name == "Foger" }
    assertEquals(listOf("Bit 35K", "SwitchPro Kits", "SwitchPro Pods"), foger.lines.map { it.name })
  }

  @Test
  fun `flavors inside a model read A to Z, whatever order they were added in`() {
    val pods = tree.brands.first { it.name == "Foger" }.lines.first { it.name == "SwitchPro Pods" }
    assertEquals(listOf("sp-1", "sp-2", "sp-3"), pods.variantIds)
  }

  @Test
  fun `a brand with one model still has that model's folder`() {
    val celsius = tree.brands.first { it.name == "Celsius" }
    assertEquals(listOf("Sparkling 12oz"), celsius.lines.map { it.name })
    assertEquals(listOf("cel-1", "cel-2"), celsius.lines.single().variantIds)
  }

  @Test
  fun `model ids keep the shape a pinned model already uses`() {
    val pods = tree.brands.first { it.name == "Foger" }.lines.first { it.name == "SwitchPro Pods" }
    assertEquals("Foger/SwitchPro Pods", pods.id)
  }

  @Test
  fun `a brand folder wears its logo, matched by id or else by name`() {
    val withLogos = buildCatalogNavigation(
      rows,
      emptyList(),
      listOf(
        BrandInfo("brand-Foger", "Foger", "/api/v1/catalog/brand-logos/foger"),
        // A different id, as when a brand was re-imported: the name still finds it.
        BrandInfo("another-id", "celsius", "/api/v1/catalog/brand-logos/celsius"),
      ),
    )
    assertEquals("/api/v1/catalog/brand-logos/foger", withLogos.brands.first { it.name == "Foger" }.coverImageUrl)
    assertEquals("/api/v1/catalog/brand-logos/celsius", withLogos.brands.first { it.name == "Celsius" }.coverImageUrl)
    assertNull(withLogos.brands.first { it.name == "Other" }.logoUrl)
  }
}

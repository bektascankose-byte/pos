package com.snappos.data

import com.snappos.data.entities.CategoryEntity
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Departments on the rail, products filed one level down.
 *
 * The shop's catalog has every vape in "Disposable Vapes" and nothing directly
 * in "Vapes", every pouch in "Nicotine Pouches" and nothing directly in
 * "Tobacco". Tapping a department has to find them.
 */
class CatalogNavigationTest {

  private fun category(id: String, path: String, parentId: String? = null) = CategoryEntity(
    id = id,
    parentId = parentId,
    name = id,
    path = path,
    depth = path.count { it == '.' },
    sortOrder = 0,
    tileColor = null,
    isDepartment = parentId == null,
  )

  private val categories = listOf(
    category("vapes", "vapes"),
    category("disposable", "vapes.disposable", "vapes"),
    category("tobacco", "tobacco"),
    category("pouches", "tobacco.nicotine-pouches", "tobacco"),
    // Starts with "vapes" but is not beneath it.
    category("vapes-kits", "vapes-kits"),
  )

  private fun line(name: String, categoryId: String) = LineNode(
    id = "$name/~",
    name = name,
    brandId = null,
    brandName = name,
    categoryIds = setOf(categoryId),
    variantIds = listOf("$name-1"),
  )

  private fun brand(name: String, categoryId: String) =
    BrandNode(name, name, setOf(categoryId), listOf(line(name, categoryId)))

  private val nav = CatalogNavigation(
    brands = listOf(brand("Foger", "disposable"), brand("Zyn", "pouches"), brand("Kit", "vapes-kits")),
    subtree = categorySubtrees(categories),
  )

  @Test
  fun `a department shows the brands filed in its subcategories`() {
    assertEquals(listOf("Foger"), nav.brandsIn("vapes").map { it.name })
    assertEquals(listOf("Zyn"), nav.brandsIn("tobacco").map { it.name })
  }

  @Test
  fun `a subcategory still shows only its own brands`() {
    assertEquals(listOf("Foger"), nav.brandsIn("disposable").map { it.name })
  }

  @Test
  fun `everything shows every brand`() {
    assertEquals(listOf("Foger", "Zyn", "Kit"), nav.brandsIn(null).map { it.name })
  }

  @Test
  fun `a category whose path only starts the same is not beneath`() {
    assertEquals(listOf("Foger"), nav.brandsIn("vapes").map { it.name })
    assertEquals(listOf("Kit"), nav.brandsIn("vapes-kits").map { it.name })
  }

  @Test
  fun `model lines follow the same rule`() {
    assertEquals(listOf("Foger"), nav.linesIn(null, "vapes").map { it.name })
    assertEquals(listOf("Foger"), nav.linesIn("Foger", "vapes").map { it.name })
    assertEquals(emptyList<String>(), nav.linesIn("Zyn", "vapes").map { it.name })
  }

  @Test
  fun `before categories have synced a category matches only itself`() {
    val bare = nav.copy(subtree = emptyMap())
    assertEquals(listOf("Foger"), bare.brandsIn("disposable").map { it.name })
    assertEquals(emptyList<String>(), bare.brandsIn("vapes").map { it.name })
  }
}

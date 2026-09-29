package com.snappos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The cases here are the shop's actual catalog, not invented ones.
 *
 * This inference decides what a customer reads on their receipt, so the tests
 * that matter most are the ones where it must decline to guess.
 */
class TaxonomyTest {

  private var seq = 0
  private fun item(brand: String?, product: String, variant: String? = null) =
    NamedItem(id = "id${seq++}", productName = product, variantName = variant, brandName = brand)

  private val fogerPodFlavours = listOf(
    "Berry Bliss", "Blackberry Blueberry", "Blackberry Passion Refresher", "Blue Dragon",
    "Blue Rancher", "Blue Razz Ice", "Blue Sour Raspberry", "Blueberry Watermelon",
    "California Cherry", "Cherry Bomb", "Cherry Slush", "Chocolate Cupcake", "Coffee",
    "Cola Slush", "Cool Mint", "Cotton Candy", "Dragon Fruit Lemonade", "Dragon Melon",
    "Frozen Banana", "Frozen Blackberry", "Frozen Blueberry", "Frozen Lemon",
    "Frozen Orange & Green", "Frozen Pineapple", "Frozen Strawberry Grapefruit",
    "Frozen Summer Pear", "Frozen Watermelon", "Frozen Wildberry Mix", "Grape Slush",
    "Gum Mint", "Gummy Bear", "Hawaiian Punch", "Juicy Peach Ice", "Kiwi Dragon Berry",
    "Lemon Heads", "Lime Berry Orange", "Mango Pineapple Refresher", "Mexico Mango",
    "Miami Mint", "NEXT Birthday Cake", "NEXT Blueberry Watermelon", "Omg B-Burst",
    "Omg B-Pop", "Orange Slush", "Sour Raspberry Punch", "Strawberry B-Burst",
    "Strawberry Banana", "Strawberry Kiwi",
  )

  private fun fogerPods() =
    fogerPodFlavours.map { item("Foger", "FOGER SwitchPro Disposable Pod $it") }

  // ------------------------------------------------------------------ shape 3

  @Test
  fun `flavour welded onto the name is split off`() {
    val items = fogerPods()
    val parts = taxonomize(items)

    val mango = parts.getValue(items.first { it.productName.endsWith("Mexico Mango") }.id)
    assertEquals("Foger", mango.brand)
    assertEquals("SwitchPro Disposable Pod", mango.line)
    assertEquals("Mexico Mango", mango.flavour)
    assertEquals("Foger SwitchPro Disposable Pod | Mexico Mango", mango.label)
    assertEquals("Mexico Mango", mango.tileLabel)
  }

  @Test
  fun `every pod lands in one model line`() {
    val parts = taxonomize(fogerPods())
    assertEquals(setOf("SwitchPro Disposable Pod"), parts.values.map { it.line }.toSet())
    assertEquals(fogerPodFlavours.size, parts.values.mapNotNull { it.flavour }.toSet().size)
  }

  /**
   * "NEXT Birthday Cake" and "NEXT Blueberry Watermelon" share a first word,
   * which is the trap: a greedier rule pulls "NEXT" out as its own model line
   * and leaves two orphan tiles in a submenu of their own.
   */
  @Test
  fun `a shared word among flavours does not become a model`() {
    val parts = taxonomize(fogerPods())
    val next = parts.values.filter { it.flavour?.startsWith("NEXT") == true }
    assertEquals(2, next.size)
    assertEquals(setOf("SwitchPro Disposable Pod"), next.map { it.line }.toSet())
  }

  // --------------------------------------------------- real model ranges split

  @Test
  fun `a brand with several model lines splits into them`() {
    val items =
      fogerPodFlavours.take(20).map { item("Foger", "FOGER SwitchPro Disposable Pod $it") } +
        listOf("Mexican Mango", "Blue Razz").map { item("Foger", "FOGER SwitchPro Kit $it") } +
        listOf("Cool Mint", "Peach Ice", "Watermelon").map { item("Foger", "FOGER Bit 35K $it") } +
        listOf("510 Thread", "Vision Spinner").map { item("Foger", "FOGER Battery $it") }

    val lines = taxonomize(items).values.mapNotNull { it.line }.toSet()
    assertEquals(
      setOf("SwitchPro Disposable Pod", "SwitchPro Kit", "Bit 35K", "Battery"),
      lines,
    )
  }

  @Test
  fun `a kit keeps its own flavours`() {
    val items =
      fogerPodFlavours.take(20).map { item("Foger", "FOGER SwitchPro Disposable Pod $it") } +
        listOf("Mexican Mango", "Blue Razz").map { item("Foger", "FOGER SwitchPro Kit $it") }

    val kit = taxonomize(items).values.first { it.line == "SwitchPro Kit" && it.flavour == "Mexican Mango" }
    assertEquals("Foger SwitchPro Kit | Mexican Mango", kit.label)
  }

  // ------------------------------------------------------ shapes 1 and 2

  @Test
  fun `a pipe in the name is believed`() {
    val items = listOf("Amazon Lemonade", "Blue Rancher", "Miami Mint", "Peach Berry")
      .map { item("Geek Bar", "Geek Bar CLR | $it") }

    val parts = taxonomize(items).getValue(items.first().id)
    assertEquals("CLR", parts.line)
    assertEquals("Amazon Lemonade", parts.flavour)
    assertEquals("Geek Bar CLR | Amazon Lemonade", parts.label)
  }

  @Test
  fun `a real variant is believed`() {
    val items = listOf("Miami Mint", "Blue Razz Ice", "Strawberry Banana", "Watermelon Ice")
      .map { item("Geek Bar", "Geek Bar Pulse X", it) }

    val parts = taxonomize(items).getValue(items.first().id)
    assertEquals("Pulse X", parts.line)
    assertEquals("Miami Mint", parts.flavour)
  }

  /**
   * One brand, all three shapes at once. The pipe and variant items must not
   * drag the inferred group's shared prefix down to "Geek Bar".
   */
  @Test
  fun `mixed shapes under one brand do not contaminate each other`() {
    val items = listOf("Amazon Lemonade", "Blue Rancher").map { item("Geek Bar", "Geek Bar CLR | $it") } +
      listOf("Miami Mint", "Blue Razz Ice").map { item("Geek Bar", "Geek Bar Pulse X", it) } +
      listOf("Mango Ice", "Grape Ice", "Cherry Ice", "Mint Ice")
        .map { item("Geek Bar", "Geek Bar Skyview 25K $it") }

    val byLine = taxonomize(items).values.groupBy { it.line }
    assertEquals(setOf("CLR", "Pulse X", "Skyview 25K"), byLine.keys)
    assertEquals(4, byLine.getValue("Skyview 25K").size)
  }

  // --------------------------------------------------------- refusing to guess

  /**
   * Six flavours of one pod branch five ways with four singletons. A rule that
   * only counted branches would call each one a model and build five submenus
   * holding one tile each.
   */
  @Test
  fun `a short flavour list is not mistaken for a model range`() {
    val items = listOf("Blue Razz", "Blue Dragon", "Cherry Bomb", "Cool Mint", "Mango", "Peach")
      .map { item("Foger", "FOGER SwitchPro Disposable Pod $it") }

    assertEquals(setOf("SwitchPro Disposable Pod"), taxonomize(items).values.map { it.line }.toSet())
  }

  @Test
  fun `a two product brand is left alone`() {
    val items = listOf("Honey Berry", "Original").map { item("Backwoods", "Backwoods Cigars 5pk $it") }
    val parts = taxonomize(items)
    assertEquals(setOf("Cigars 5pk"), parts.values.map { it.line }.toSet())
    assertEquals(setOf("Honey Berry", "Original"), parts.values.map { it.flavour }.toSet())
  }

  @Test
  fun `an unbranded shelf is not forced into a structure`() {
    val items = listOf("Coca-Cola 20oz", "Red Bull 8.4oz", "Bic Lighter", "Monster Ultra")
      .map { item(null, it) }

    for ((id, parts) in taxonomize(items)) {
      assertNull("no line should be invented for $id", parts.line)
      assertNull("no flavour should be invented for $id", parts.flavour)
    }
    assertEquals(
      setOf("Coca-Cola 20oz", "Red Bull 8.4oz", "Bic Lighter", "Monster Ultra"),
      taxonomize(items).values.map { it.label }.toSet(),
    )
  }

  @Test
  fun `a lone product keeps its whole name`() {
    val items = listOf(item("Zyn", "Zyn Cool Mint 6mg"))
    val parts = taxonomize(items).getValue(items.first().id)
    assertEquals("Zyn Cool Mint 6mg", parts.label)
  }

  @Test
  fun `a name that is only its brand does not become empty`() {
    val items = listOf(item("Backwoods", "Backwoods"), item("Backwoods", "Backwoods Original"))
    for (parts in taxonomize(items).values) {
      assertEquals(true, parts.label.isNotBlank())
      assertEquals(true, parts.tileLabel.isNotBlank())
    }
  }

  @Test
  fun `empty catalog is empty`() {
    assertEquals(emptyMap<String, ProductNameParts>(), taxonomize(emptyList()))
  }
}

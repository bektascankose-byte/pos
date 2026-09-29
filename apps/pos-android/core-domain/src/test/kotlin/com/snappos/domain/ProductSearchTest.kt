package com.snappos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Names, brands, SKUs and barcodes are the shop's own, copied from the live
 * catalog -- including the brand field left blank on most of the Kits, and the
 * "KIt" the supplier typed.
 */
class ProductSearchTest {

  private class Row(val brand: String?, val product: String, val variant: String?, val code: String) {
    val id = "$product|$variant|$code"
  }

  private val rows = buildList {
    listOf(
      "Berry Bliss", "Blue Razz Ice", "Cherry Slush", "Cool Mint", "Frozen Watermelon", "Gum Mint",
      "Juicy Peach Ice", "Kiwi Dragon Berry", "Miami Mint", "Strawberry Banana",
    ).forEachIndexed { i, flavour ->
      val barcode = if (flavour == "Blue Razz Ice") "6971824064056" else "69718240700$i"
      add(Row("Foger", "FOGER SwitchPro Disposable Pod $flavour", null, barcode))
    }
    listOf("Strawberry Slush", "Triple Berry Punch").forEachIndexed { i, flavour ->
      add(Row(null, "FOGER SwitchPro Disposable Pod $flavour", null, "69718240710$i"))
    }
    listOf(
      "Blue Razz Ice", "Cherry Slush", "Cool Mint", "Gummy Bear", "Juicy Peach Ice",
      "Peach Berries Refresher", "Strawberry Kiwi", "Watermelon Ice",
    ).forEachIndexed { i, flavour ->
      add(Row(null, "FOGER SwitchPro KIt 30K $flavour", null, "69718240720$i"))
    }
    add(Row("Geek Bar", "Geek Bar CLR | Amazon Lemonade", null, "810203875882"))
    add(Row("Geek Bar", "Geek Bar CLR | Miami Mint", null, "810203875707"))
    add(Row(null, "Geek Bar CLR | Banana Ice", null, "810203875868"))
    add(Row(null, "Geek Bar Mate Pod | Blue Razz Ice", null, "810203875240"))
    add(Row(null, "Geek Bar Mate Pod | Cool Mint", null, "810203875127"))
    add(Row(null, "Geek Bar Pulse 2 | Blue Razz Hubba", null, "810203875424"))
    add(Row("Geek Bar", "Geek Bar Pulse X", "Blue Razz Ice", "GB-PULSEX-BR"))
    add(Row("Geek Bar", "Geek Bar Pulse X", "Miami Mint", "GB-PULSEX-MM"))
    add(Row("Lost Mary", "Lost Mary BM6000", "Blueberry Ice", "LM-BM6000-BB"))
    add(Row("Zyn", "Zyn Nicotine Pouches", "Cool Mint 6mg", "ZYN-COOL-6"))
    add(Row("Backwoods", "Backwoods Cigars 5pk", "Honey Berry", "BW-HONEY-5"))
  }

  private val parts = taxonomize(rows.map { NamedItem(it.id, it.product, it.variant, it.brand) })

  /** Built the way the register builds it: the taxonomy's names plus the raw text. */
  private val index = ProductSearchIndex(
    rows.map { row ->
      val p = parts[row.id]
      SearchDocument.of(row.id, p?.brand, p?.line, p?.flavour, row.product, row.variant, row.brand, row.code)
    },
  )

  private fun labels(query: String, limit: Int = Int.MAX_VALUE) =
    index.search(query, limit).map { parts.getValue(it).label }

  private val kitBlueRazz = "Foger SwitchPro KIt 30K | Blue Razz Ice"
  private val podBlueRazz = "Foger SwitchPro Disposable Pod | Blue Razz Ice"

  // ------------------------------------------------------ what the shop asked for

  @Test
  fun `the three ways the shop types it all find the kit`() {
    for (query in listOf("Fog Razz", "Foger Razz", "Foger Switch Razz")) {
      assertTrue("$query -> ${labels(query)}", kitBlueRazz in labels(query))
    }
  }

  @Test
  fun `fog razz finds the Foger razzes and nothing else`() {
    assertEquals(listOf(podBlueRazz, kitBlueRazz), labels("fog razz"))
  }

  @Test
  fun `every typed word has to land`() {
    val found = labels("foger mint")
    assertTrue(found.isNotEmpty())
    assertTrue(found.toString(), found.all { it.startsWith("Foger") })
  }

  @Test
  fun `word order does not matter`() {
    assertEquals(labels("foger razz"), labels("razz foger"))
  }

  @Test
  fun `case does not matter`() {
    assertEquals(labels("foger razz"), labels("FOGER RAZZ"))
  }

  // ------------------------------------------------------ how names are written

  @Test
  fun `a brand the catalog left blank is still found by its name`() {
    // The Kits carry no brand in the catalog. The taxonomy files them under
    // Foger for the folders, and search has to agree with the folders.
    assertTrue(kitBlueRazz in labels("foger kit razz"))
  }

  @Test
  fun `a supplier's run-together words answer to either half`() {
    assertTrue(kitBlueRazz in labels("switch pro razz"))
    assertTrue(kitBlueRazz in labels("pro razz"))
    assertEquals(listOf("Lost Mary BM6000 | Blueberry Ice"), labels("6000"))
  }

  @Test
  fun `two words typed as one still match`() {
    val found = labels("geekbar razz")
    assertEquals(
      setOf(
        "Geek Bar Mate Pod | Blue Razz Ice",
        "Geek Bar Pulse 2 | Blue Razz Hubba",
        "Geek Bar Pulse X | Blue Razz Ice",
      ),
      found.toSet(),
    )
  }

  @Test
  fun `an apostrophe is not a word break`() {
    val index = ProductSearchIndex(listOf(SearchDocument.of("h", "Hershey's Milk Chocolate")))
    assertEquals(listOf("h"), index.search("hersheys"))
    assertEquals(listOf("h"), index.search("hershey milk"))
  }

  // ------------------------------------------------------ codes

  @Test
  fun `the tail of a barcode still finds it, as the old search did`() {
    assertEquals(listOf(podBlueRazz), labels("4064056"))
  }

  @Test
  fun `a sku is searchable by its pieces`() {
    assertEquals(
      setOf("Geek Bar Pulse X | Blue Razz Ice", "Geek Bar Pulse X | Miami Mint"),
      labels("gb-pulsex").toSet(),
    )
  }

  // ------------------------------------------------------ ranking

  @Test
  fun `whole words outrank starts of words, which outrank the middle of one`() {
    // Listed worst first, so the order that comes back is the ranking's doing.
    val index = ProductSearchIndex(
      listOf(
        SearchDocument.of("inside", "Superrazz Mix"),
        SearchDocument.of("start", "Razzle Punch"),
        SearchDocument.of("whole", "Blue Razz Ice"),
      ),
    )
    assertEquals(listOf("whole", "start", "inside"), index.search("razz"))
  }

  @Test
  fun `the middle of a word still finds things, after the whole words`() {
    // The old substring search found Strawberry for "berry". Taking that away
    // would be a regression found at the counter, so it stays -- below the
    // products that have "berry" as a word of its own.
    val found = labels("berry")
    val whole = setOf(
      "Foger SwitchPro Disposable Pod | Berry Bliss",
      "Foger SwitchPro Disposable Pod | Kiwi Dragon Berry",
      "Foger SwitchPro Disposable Pod | Triple Berry Punch",
      "Backwoods Cigars 5pk | Honey Berry",
    )
    assertEquals(whole, found.take(whole.size).toSet())
    assertTrue(found.toString(), "Foger SwitchPro Disposable Pod | Strawberry Banana" in found.drop(whole.size))
    assertTrue(found.toString(), "Lost Mary BM6000 | Blueberry Ice" in found.drop(whole.size))
  }

  @Test
  fun `two letters never match inside a word`() {
    val index = ProductSearchIndex(listOf(SearchDocument.of("p", "Juicy Peach Ice")))
    assertEquals(emptyList<String>(), index.search("ce"))
    assertEquals(listOf("p"), index.search("ic"))
  }

  @Test
  fun `ties keep the menu's order, and the limit is honoured`() {
    val foger = labels("foger")
    assertEquals(rows.count { it.product.startsWith("FOGER") }, foger.size)
    assertEquals(foger.take(3), labels("foger", limit = 3))
    assertEquals("Foger SwitchPro Disposable Pod | Berry Bliss", foger.first())
  }

  @Test
  fun `nothing typed finds nothing`() {
    assertEquals(emptyList<String>(), labels(""))
    assertEquals(emptyList<String>(), labels("   "))
    assertEquals(emptyList<String>(), labels("| - |"))
  }

  @Test
  fun `a word that matches nothing empties the results`() {
    assertEquals(emptyList<String>(), labels("foger zebra"))
  }
}

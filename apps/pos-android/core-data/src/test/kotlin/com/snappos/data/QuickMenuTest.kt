package com.snappos.data

import org.junit.Assert.assertEquals
import org.junit.Test

class QuickMenuTest {

  private fun product(id: String, label: String = id) = QuickTab(QuickTabKind.Product, id, label)
  private val foger = QuickTab(QuickTabKind.Brand, "Foger", "Foger")
  private val everything = QuickTab(QuickTabKind.Everything, null, "Everything")

  // ------------------------------------------------------------------ toggle

  @Test
  fun `a new pin goes to the bottom`() {
    val (next, result) = QuickMenu.toggle(listOf(foger), product("pod-razz"))
    assertEquals(PinResult.Pinned, result)
    assertEquals(listOf("Brand:Foger", "Product:pod-razz"), next.map { it.key })
  }

  @Test
  fun `pinning what is pinned unpins it, whatever it is called now`() {
    val (next, result) = QuickMenu.toggle(listOf(product("pod-razz", "Blue Razz")), product("pod-razz", "Blue Razz Ice"))
    assertEquals(PinResult.Unpinned, result)
    assertEquals(emptyList<QuickTab>(), next)
  }

  @Test
  fun `a full menu refuses instead of dropping the pin`() {
    val full = (1..QuickMenu.MAX).map { product("p$it") }
    val (next, result) = QuickMenu.toggle(full, product("one-more"))
    assertEquals(PinResult.Full, result)
    assertEquals(full, next)
  }

  @Test
  fun `a full menu still unpins`() {
    val full = (1..QuickMenu.MAX).map { product("p$it") }
    val (next, result) = QuickMenu.toggle(full, product("p3"))
    assertEquals(PinResult.Unpinned, result)
    assertEquals(QuickMenu.MAX - 1, next.size)
  }

  @Test
  fun `a product and a place with the same target are different pins`() {
    val line = QuickTab(QuickTabKind.Line, "x", "Line x")
    val (next, _) = QuickMenu.toggle(listOf(line), product("x"))
    assertEquals(2, next.size)
  }

  // ------------------------------------------------------------------ reorder

  @Test
  fun `reorder takes the order the screen showed`() {
    val menu = listOf(product("a"), product("b"), foger, product("c"))
    val next = QuickMenu.reorder(menu, listOf("Product:c", "Product:a", "Brand:Foger", "Product:b"))
    assertEquals(listOf("Product:c", "Product:a", "Brand:Foger", "Product:b"), next.map { it.key })
  }

  @Test
  fun `a pin the screen did not know about keeps its place at the end`() {
    val menu = listOf(product("a"), product("b"), product("new"))
    val next = QuickMenu.reorder(menu, listOf("Product:b", "Product:a"))
    assertEquals(listOf("Product:b", "Product:a", "Product:new"), next.map { it.key })
  }

  @Test
  fun `keys that no longer exist are ignored`() {
    val next = QuickMenu.reorder(listOf(product("a")), listOf("Product:gone", "Product:a", "Product:a"))
    assertEquals(listOf("Product:a"), next.map { it.key })
  }

  @Test
  fun `remove takes out exactly one entry`() {
    val next = QuickMenu.remove(listOf(product("a"), foger, product("b")), "Brand:Foger")
    assertEquals(listOf("Product:a", "Product:b"), next.map { it.key })
  }

  // ------------------------------------------------------------------ storage

  @Test
  fun `the order survives being saved`() {
    val menu = listOf(product("b", "Blue Razz Ice"), everything, foger, product("a", "Cool Mint | 6mg"))
    assertEquals(menu, QuickMenu.decode(QuickMenu.encode(menu)))
  }

  @Test
  fun `a menu saved by an older build still reads`() {
    val raw = "Brand\u001FFoger\u001FFoger\nEverything\u001F\u001FEverything"
    assertEquals(listOf(foger, everything), QuickMenu.decode(raw))
  }

  @Test
  fun `a kind this build does not know is skipped, not fatal`() {
    val raw = "Lottery\u001F7\u001FScratchers\nProduct\u001Fa\u001FA"
    assertEquals(listOf(product("a", "A")), QuickMenu.decode(raw))
  }

  @Test
  fun `nothing saved is an empty menu`() {
    assertEquals(emptyList<QuickTab>(), QuickMenu.decode(null))
    assertEquals(emptyList<QuickTab>(), QuickMenu.decode(""))
  }
}

package com.snappos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cart arithmetic.
 *
 * The invariant every one of these protects is the one the server re-checks on
 * upload: the cart total must equal the sum of its line totals plus tip. When
 * it does not, a customer was charged something the reports will not recognise.
 */
class CartTest {

  private val TAX = "0.0825"

  private fun cartWith(vararg items: Triple<String, String, Int>): Cart =
    items.foldIndexed(Cart.EMPTY) { index, cart, (sku, price, qty) ->
      cart.addItem(
        id = "line-$index",
        variantId = "variant-$sku",
        description = sku,
        sku = sku,
        unitPrice = Money.fromMajor(price),
        quantity = qty,
        taxRate = TAX,
      )
    }

  @Test
  fun `an empty cart totals zero`() {
    assertTrue(Cart.EMPTY.isEmpty)
    assertEquals(Money.ZERO, Cart.EMPTY.total)
    assertEquals(0, Cart.EMPTY.itemCount)
  }

  @Test
  fun `a realistic basket totals to the cent`() {
    val cart = cartWith(
      Triple("GB-MM", "24.99", 2),
      Triple("BW-HONEY", "6.49", 1),
      Triple("MON-ULTRA", "3.99", 1),
    )

    assertEquals("60.46", cart.subtotal.toMajorString())
    assertEquals("4.99", cart.taxTotal.toMajorString())
    assertEquals("65.45", cart.total.toMajorString())
    assertEquals(4, cart.itemCount)
  }

  @Test
  fun `the cart total always equals the sum of its line totals plus tip`() {
    val cart = cartWith(
      Triple("A", "24.99", 3),
      Triple("B", "6.49", 2),
      Triple("C", "3.99", 1),
      Triple("D", "19.99", 1),
    ).withTip(Money.fromMajor("2.00"))

    val lineSum = Money.sum(cart.effectiveLines.map { it.total })
    assertEquals(cart.total, lineSum + cart.tip)
  }

  @Test
  fun `scanning the same item twice increments one line rather than adding two`() {
    // A cashier ringing six identical drinks should see one row reading 6, not
    // six rows to scroll past.
    var cart = Cart.EMPTY
    repeat(6) { index ->
      cart = cart.addItem(
        id = "line-$index",
        variantId = "variant-monster",
        description = "Monster Ultra",
        sku = "MON-ULTRA",
        unitPrice = Money.fromMajor("3.99"),
        taxRate = TAX,
      )
    }
    assertEquals(1, cart.lines.size)
    assertEquals(6, cart.lines.first().quantity)
    assertEquals("23.94", cart.subtotal.toMajorString())
  }

  @Test
  fun `a line with a different price does not merge with one at the shelf price`() {
    // Merging these would silently hide that one of them was overridden.
    val cart = Cart.EMPTY
      .addItem("a", "v1", "Geek Bar", "GB", Money.fromMajor("24.99"), taxRate = TAX)
      .overridePrice("a", Money.fromMajor("19.99"), authorizedBy = "manager-1", reason = "damaged box")
      .addItem("b", "v1", "Geek Bar", "GB", Money.fromMajor("24.99"), taxRate = TAX)

    assertEquals(2, cart.lines.size)
  }

  @Test
  fun `a cart discount spreads across lines and still sums to the total`() {
    // If the discount stayed at cart level the line amounts would no longer add
    // up to the total, and the receipt, the tax report and any partial refund
    // would each have to reinvent the split.
    val cart = cartWith(
      Triple("A", "49.98", 1),
      Triple("B", "6.49", 1),
      Triple("C", "3.99", 1),
    ).applyCartDiscount(Money.fromMajor("5.00"), "manager courtesy")

    // A discount is a positive reduction, by convention and by constructor check.
    assertEquals("5.00", cart.discountTotal.toMajorString())

    val lineSum = Money.sum(cart.effectiveLines.map { it.total })
    assertEquals(cart.total, lineSum)

    // And the discount itself is not lost to rounding across three lines.
    val spread = Money.sum(cart.effectiveLines.map { it.discount })
    assertEquals(Money.fromMajor("5.00"), spread)
  }

  @Test
  fun `a cart discount that does not divide evenly still sums exactly`() {
    val cart = cartWith(
      Triple("A", "10.00", 1),
      Triple("B", "10.00", 1),
      Triple("C", "10.00", 1),
    ).applyCartDiscount(Money.fromMajor("0.01"), "one cent")

    assertEquals(Money.fromMajor("0.01"), Money.sum(cart.effectiveLines.map { it.discount }))
    assertEquals(cart.total, Money.sum(cart.effectiveLines.map { it.total }))
  }

  @Test
  fun `tax is charged after the discount, not before`() {
    val cart = cartWith(Triple("A", "100.00", 1))
      .applyCartDiscount(Money.fromMajor("10.00"), "promo")

    // 90.00 taxed at 8.25% is 7.43, not 8.25.
    assertEquals("7.43", cart.taxTotal.toMajorString())
    assertEquals("97.43", cart.total.toMajorString())
  }

  @Test
  fun `a tax exempt sale charges no tax and says why`() {
    val cart = cartWith(Triple("A", "100.00", 1)).exemptTax("resale certificate 1234")

    assertEquals(Money.ZERO, cart.taxTotal)
    assertEquals("100.00", cart.total.toMajorString())
    assertEquals("resale certificate 1234", cart.taxExemptReason)
  }

  @Test
  fun `a price override records who authorized it and how far off shelf price it went`() {
    val cart = Cart.EMPTY
      .addItem("a", "v1", "Geek Bar", "GB", Money.fromMajor("24.99"), quantity = 2, taxRate = TAX)
      .overridePrice("a", Money.fromMajor("19.99"), authorizedBy = "manager-1", reason = "damaged box")

    val line = cart.lines.first()
    assertTrue(line.isPriceOverridden)
    assertEquals("manager-1", line.priceOverriddenBy)
    // Two units, five dollars under each.
    assertEquals("-10.00", line.priceVariance.toMajorString())
  }

  @Test
  fun `removing a line renumbers the rest`() {
    val cart = cartWith(
      Triple("A", "1.00", 1),
      Triple("B", "2.00", 1),
      Triple("C", "3.00", 1),
    ).removeLine("line-0")

    assertEquals(listOf(1, 2), cart.lines.map { it.lineNo })
    assertEquals("5.00", cart.subtotal.toMajorString())
  }

  @Test
  fun `setting a quantity to zero removes the line`() {
    val cart = cartWith(Triple("A", "1.00", 1), Triple("B", "2.00", 1))
      .setQuantity("line-0", 0)

    assertEquals(1, cart.lines.size)
  }

  @Test
  fun `a negative discount is refused at construction`() {
    // A sign error here does not crash, it charges the customer more, and the
    // totals still add up internally. So it is refused where it is created.
    assertThrows(IllegalArgumentException::class.java) {
      LineAdjustment.ManualDiscount(Money.fromMajor("-5.00"), "wrong sign")
    }
    assertThrows(IllegalArgumentException::class.java) {
      Cart.EMPTY.applyCartDiscount(Money.fromMajor("-5.00"), "wrong sign")
    }
  }

  @Test
  fun `a price override cannot make a line negative`() {
    // overridePrice replaces unitPrice via copy(), which re-runs CartLine's own
    // init block — the same guard an ordinary sale line gets, checked again
    // regardless of what a dialog upstream already validated.
    val cart = Cart.EMPTY
      .addItem("a", "v1", "Geek Bar", "GB", Money.fromMajor("24.99"), taxRate = TAX)

    assertThrows(IllegalArgumentException::class.java) {
      cart.overridePrice("a", Money.fromMajor("-1.00"), authorizedBy = "manager-1", reason = "typo")
    }

    // Zero is a legitimate override (a discretionary give-away), unlike negative.
    val given = cart.overridePrice("a", Money.ZERO, authorizedBy = "manager-1", reason = "goodwill")
    assertEquals(Money.ZERO, given.lines.first().unitPrice)
  }

  @Test
  fun `a zero quantity line cannot be constructed`() {
    assertThrows(IllegalArgumentException::class.java) {
      CartLine(
        id = "x", lineNo = 1, variantId = "v", description = "d", sku = "s",
        quantity = 0, unitPrice = Money.fromMajor("1.00"), catalogPrice = Money.fromMajor("1.00"),
      )
    }
  }

  // ----------------------------------------------------------------- age gate

  @Test
  fun `an age restricted line blocks until it is verified`() {
    val cart = Cart.EMPTY.addItem(
      id = "a", variantId = "v1", description = "Geek Bar Pulse X", sku = "GB",
      unitPrice = Money.fromMajor("24.99"), taxRate = TAX,
      minimumAge = 21, idScanRequired = true,
    )

    assertTrue(cart.requiresAgeVerification)
    assertEquals(1, cart.unverifiedAgeRestrictedLines.size)
    assertEquals(21, cart.minimumAgeRequired)

    val verified = cart.markAgeVerified()
    assertFalse(verified.requiresAgeVerification)
  }

  @Test
  fun `a cart of unrestricted items never prompts`() {
    // The compliance engine must be able to say "no prompt" as confidently as it
    // says "prompt". A cart of only regulated SKUs would never exercise this.
    val cart = cartWith(Triple("MON-ULTRA", "3.99", 1))
    assertFalse(cart.requiresAgeVerification)
    assertNull(cart.minimumAgeRequired)
  }

  @Test
  fun `the highest age across mixed lines is what the cashier is prompted for`() {
    val cart = Cart.EMPTY
      .addItem("a", "v1", "Monster", "MON", Money.fromMajor("3.99"), taxRate = TAX)
      .addItem("b", "v2", "Geek Bar", "GB", Money.fromMajor("24.99"), taxRate = TAX, minimumAge = 21)
      .addItem("c", "v3", "Lighter", "LTR", Money.fromMajor("1.99"), taxRate = TAX, minimumAge = 18)

    assertEquals(21, cart.minimumAgeRequired)
    assertEquals(2, cart.unverifiedAgeRestrictedLines.size)
  }

  // ------------------------------------------------------------- line detail

  @Test
  fun `a line discount reduces what tax is charged on`() {
    val cart = cartWith(Triple("A", "100.00", 1))
      .discountLine("line-0", Money.fromMajor("20.00"), "loyalty")

    val line = cart.effectiveLines.first()
    assertEquals("80.00", line.taxable.toMajorString())
    assertEquals("6.60", line.tax.toMajorString())
    assertEquals("86.60", line.total.toMajorString())
  }

  @Test
  fun `tax rounds per line, and lines still sum to the cart total`() {
    // Three lines that each round independently. The cart total must equal the
    // sum of the rounded line totals, not a total computed on the raw subtotal,
    // or the receipt disagrees with itself by a cent.
    val cart = cartWith(
      Triple("A", "0.99", 1),
      Triple("B", "0.99", 1),
      Triple("C", "0.99", 1),
    )
    val lineSum = Money.sum(cart.effectiveLines.map { it.total })
    assertEquals(cart.total, lineSum)
  }
}

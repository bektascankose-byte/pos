package com.snappos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * These are the same cases as `packages/contracts/src/money.test.ts`, on
 * purpose.
 *
 * Two implementations of one rule set drift. That is not a risk, it is a
 * certainty given enough time, and in a pricing engine drift means a customer
 * was charged something the reports disagree with. Mirroring the assertions is
 * the cheap half of the defence; the language neutral conformance fixtures that
 * both engines run are the other half.
 *
 * If a case is changed here, change it there in the same commit.
 */
class MoneyTest {

  @Test
  fun `minor units round trip through major-unit strings`() {
    assertEquals("24.99", Money.fromMajor("24.99").toMajorString())
    assertEquals("24.90", Money.fromMajor("24.9").toMajorString())
    assertEquals("24.00", Money.fromMajor("24").toMajorString())
    assertEquals("0.05", Money.fromMajor("0.05").toMajorString())
    assertEquals("-3.50", Money.fromMajor("-3.50").toMajorString())
    assertEquals(2499L, Money.fromMajor("24.99").minor)
  }

  @Test
  fun `more precision than a cent is refused, not truncated`() {
    assertThrows(MoneyFormatException::class.java) { Money.fromMajor("24.999") }
    assertThrows(MoneyFormatException::class.java) { Money.deserialize("24.99") }
  }

  @Test
  fun `the classic float failure does not occur`() {
    // 0.1 + 0.2 != 0.3 in IEEE-754. This is the whole reason the type exists.
    assertNotEquals(0.3, 0.1 + 0.2, 0.0)
    assertEquals(Money.fromMajor("0.30"), Money.fromMajor("0.10") + Money.fromMajor("0.20"))

    // A hundred nickels is exactly five dollars, every time.
    val nickels = List(100) { Money.fromMajor("0.05") }
    assertEquals("5.00", Money.sum(nickels).toMajorString())
  }

  @Test
  fun `a realistic cart totals to the cent`() {
    val lines = listOf(
      Money.fromMajor("24.99") * 2,
      Money.fromMajor("6.49"),
      Money.fromMajor("3.99"),
    )
    val subtotal = Money.sum(lines)
    assertEquals("60.46", subtotal.toMajorString())

    val taxable = subtotal + Money.fromMajor("-6.49")
    val tax = taxable.applyRate("0.0825")
    assertEquals("4.45", tax.toMajorString())
    assertEquals("58.42", (taxable + tax).toMajorString())
  }

  @Test
  fun `tax rounds half up, away from zero`() {
    // 1000 * 0.0825 = 82.5 exactly. Half up gives 83, banker's gives 82.
    assertEquals(83L, Money(1000).applyRate("0.0825").minor)
    assertEquals(-83L, Money(-1000).applyRate("0.0825").minor)
    assertEquals(1L, Money(1).applyRate("0.5").minor)
    assertEquals(0L, Money(1).applyRate("0.49").minor)
  }

  @Test
  fun `tax on a rate binary floating point cannot represent`() {
    // 8.25 * 100 in floating point is 824.9999999999999.
    val amount = Money.fromMajor("8.25")
    assertEquals(825L, amount.minor)
    assertEquals(68L, amount.applyRate("0.0825").minor)
  }

  @Test
  fun `allocate never loses or invents a cent`() {
    val parts = Money.fromMajor("10.00").allocate(3)
    assertEquals(listOf("3.34", "3.33", "3.33"), parts.map { it.toMajorString() })
    assertEquals(Money.fromMajor("10.00"), Money.sum(parts))

    for ((amount, n) in listOf("0.01" to 3, "99.99" to 7, "-10.00" to 3, "0.00" to 4)) {
      val split = Money.fromMajor(amount).allocate(n)
      assertEquals(n, split.size)
      assertEquals("$amount across $n", Money.fromMajor(amount), Money.sum(split))
    }
  }

  @Test
  fun `weighted allocation sums back exactly`() {
    // A $5.00 cart discount across lines of 49.98, 6.49 and 3.99.
    val weights = listOf(
      Money.fromMajor("49.98"),
      Money.fromMajor("6.49"),
      Money.fromMajor("3.99"),
    )
    val shares = Money.fromMajor("-5.00").allocateByWeight(weights)
    assertEquals(Money.fromMajor("-5.00"), Money.sum(shares))
    assertEquals(3, shares.size)
    // The largest line absorbs the most discount.
    assertTrue(shares[0] < shares[1])
  }

  @Test
  fun `weights that are all zero fall back to an even split`() {
    val shares = Money.fromMajor("1.00")
      .allocateByWeight(listOf(Money.ZERO, Money.ZERO, Money.ZERO))
    assertEquals(Money.fromMajor("1.00"), Money.sum(shares))
  }

  @Test
  fun `money crosses the wire as a string`() {
    val value = Money.fromMajor("24.99")
    assertEquals("2499", value.serialize())
    assertEquals(value, Money.deserialize("2499"))

    // Above 2^53 a JSON number would silently lose precision. A Long does not.
    val huge = Money.deserialize("9007199254740993")
    assertEquals(huge, Money.deserialize(huge.serialize()))
    assertNotEquals(huge.serialize(), huge.minor.toDouble().toLong().toString())
  }

  @Test
  fun `cost keeps six decimals until it is posted`() {
    // A case of 12 at $5.00 is $0.416667 a unit. Rounding to cents first and
    // multiplying back gives 4.92, and margin reports drift from there.
    assertEquals(500L, costToMinor("0.416667", 12).minor)
    assertEquals("5.00", costToMinor("0.416667", 12).toMajorString())
  }

  @Test
  fun `subtraction and negative balances behave`() {
    assertEquals("-2.50", (Money.fromMajor("5.00") - Money.fromMajor("7.50")).toMajorString())
    assertEquals(Money.ZERO, Money.sum(emptyList()))
  }

  @Test
  fun `overflow throws rather than wrapping`() {
    // A silently wrapped total is the worst possible failure for money.
    assertThrows(ArithmeticException::class.java) {
      Money(Long.MAX_VALUE) + Money(1)
    }
  }
}

package com.snappos.domain

import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReceiptTest {

  private val zone = ZoneId.of("America/Chicago")

  private fun receipt(
    items: List<ReceiptItem> = listOf(
      ReceiptItem("Geek Bar Pulse X - Miami Mint", 1, Money.ofMinor(2499), Money.ofMinor(2499)),
    ),
    minimumAge: Int? = null,
    ageVerified: Boolean = false,
    change: Money = Money.ZERO,
    reprint: Boolean = false,
  ) = SaleReceipt(
    store = ReceiptStore("Harker Heights Smoke", listOf("123 Main St"), "254-555-0142"),
    receiptNo = "HH01-R1-1187",
    soldAt = Instant.parse("2026-09-11T20:32:00Z"),
    cashierName = "Maria",
    registerName = "Register 1",
    items = items,
    subtotal = Money.ofMinor(items.sumOf { it.lineTotal.minor }),
    tax = Money.ofMinor(206),
    total = Money.ofMinor(items.sumOf { it.lineTotal.minor } + 206),
    tenders = listOf(ReceiptTender("cash", Money.ofMinor(3000))),
    change = change,
    minimumAge = minimumAge,
    ageVerified = ageVerified,
    footer = listOf("Returns within 14 days with receipt"),
    reprint = reprint,
  )

  private fun lines(width: PaperWidth, r: SaleReceipt = receipt()) =
    TextReceipt.render(ReceiptRenderer.render(r, zone), width)

  // ------------------------------------------------------------------ width

  @Test
  fun `no line exceeds the paper width`() {
    for (width in PaperWidth.entries) {
      lines(width).forEach {
        assertTrue(
          "$width: ${it.length} columns in \"$it\"",
          it.length <= width.columns,
        )
      }
    }
  }

  @Test
  fun `the same receipt renders at both widths`() {
    // Not an identical rendering — an identical *document*. The point of the
    // abstract document is that changing paper does not change the receipt.
    val document = ReceiptRenderer.render(receipt(), zone)
    val narrow = TextReceipt.render(document, PaperWidth.Mm58)
    val wide = TextReceipt.render(document, PaperWidth.Mm80)

    assertTrue(narrow.isNotEmpty() && wide.isNotEmpty())
    assertTrue(narrow.any { it.contains("HH01-R1-1187") })
    assertTrue(wide.any { it.contains("HH01-R1-1187") })
  }

  @Test
  fun `amounts are flush to the right edge`() {
    // A receipt is checked by running a finger down the right hand column, so
    // every amount has to end in the last column, whatever the label did.
    for (width in PaperWidth.entries) {
      val total = lines(width).first { it.startsWith("TOTAL") }
      assertEquals("$width: \"$total\"", width.columns, total.length)
      assertTrue("$width: \"$total\"", total.endsWith("27.05"))
    }
  }

  @Test
  fun `a long description wraps instead of pushing the amount off the line`() {
    val long = receipt(
      items = listOf(
        ReceiptItem(
          "Backwoods Russian Cream Cigars 5 Pack Limited Edition",
          1,
          Money.ofMinor(649),
          Money.ofMinor(649),
        ),
      ),
    )
    val rendered = lines(PaperWidth.Mm58, long)

    val amountLine = rendered.first { it.endsWith("6.49") }
    assertEquals(PaperWidth.Mm58.columns, amountLine.length)
    // The rest of the name is still on the receipt, on following lines.
    assertTrue(rendered.joinToString("\n"), rendered.any { it.contains("Edition") })
  }

  // ------------------------------------------------------------- quantities

  @Test
  fun `a single unit does not print a quantity line`() {
    assertFalse(lines(PaperWidth.Mm80).any { it.contains("@") })
  }

  @Test
  fun `more than one unit shows the arithmetic the customer checks`() {
    val two = receipt(
      items = listOf(
        ReceiptItem("Geek Bar Pulse X", 2, Money.ofMinor(2499), Money.ofMinor(4998)),
      ),
    )
    assertTrue(lines(PaperWidth.Mm80, two).any { it.trim() == "2 @ 24.99" })
  }

  // ------------------------------------------------------------- compliance

  @Test
  fun `a verified age restricted sale records that the check happened`() {
    val rendered = lines(PaperWidth.Mm80, receipt(minimumAge = 21, ageVerified = true))
    assertTrue(rendered.joinToString("\n"), rendered.any { it.contains("21+ ID verified") })
  }

  @Test
  fun `the receipt carries no identity data from the age check`() {
    // The check is a fact; the customer's document is not the shop's to print.
    // A receipt ends up in a bin behind the counter, and a date of birth or a
    // licence number on it is a data breach made of paper.
    val rendered = lines(PaperWidth.Mm80, receipt(minimumAge = 21, ageVerified = true))
      .joinToString("\n")
      .lowercase()

    for (forbidden in listOf("birth", "dob", "licen", "id number", "driver")) {
      assertFalse("receipt leaked \"$forbidden\"", rendered.contains(forbidden))
    }
  }

  @Test
  fun `an unverified age restriction is not claimed as verified`() {
    val rendered = lines(PaperWidth.Mm80, receipt(minimumAge = 21, ageVerified = false))
    assertFalse(rendered.any { it.contains("ID verified") })
  }

  // ----------------------------------------------------------------- basics

  @Test
  fun `change is shown only when there is change`() {
    assertFalse(lines(PaperWidth.Mm80).any { it.startsWith("Change") })
    assertTrue(
      lines(PaperWidth.Mm80, receipt(change = Money.ofMinor(295)))
        .any { it.startsWith("Change") && it.endsWith("2.95") },
    )
  }

  @Test
  fun `a reprint says so where it cannot be missed`() {
    val rendered = lines(PaperWidth.Mm80, receipt(reprint = true))
    assertTrue(rendered.joinToString("\n"), rendered.take(8).any { it.contains("REPRINT") })
    assertFalse(lines(PaperWidth.Mm80).any { it.contains("REPRINT") })
  }

  @Test
  fun `the receipt number is printed for a return to be found by`() {
    val rendered = lines(PaperWidth.Mm58)
    // Once in the header, once at the foot as the machine readable copy.
    assertEquals(rendered.joinToString("\n"), 2, rendered.count { it.contains("HH01-R1-1187") })
  }

  @Test
  fun `the store and the cashier are on it`() {
    val rendered = lines(PaperWidth.Mm80).joinToString("\n")
    assertTrue(rendered, rendered.contains("Harker Heights Smoke"))
    assertTrue(rendered, rendered.contains("Maria"))
    assertTrue(rendered, rendered.contains("Register 1"))
  }

  @Test
  fun `the timestamp is rendered in the store's zone, not UTC`() {
    // 20:32 UTC is 15:32 in Chicago. A receipt timestamped in UTC is one a
    // shop cannot match against its own till roll.
    assertTrue(
      lines(PaperWidth.Mm80).joinToString("\n"),
      lines(PaperWidth.Mm80).any { it.contains("2026-09-11 15:32") },
    )
  }
}

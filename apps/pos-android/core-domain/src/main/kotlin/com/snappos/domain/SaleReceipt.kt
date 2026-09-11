package com.snappos.domain

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** The shop, as it appears at the top of a receipt. */
data class ReceiptStore(
  val name: String,
  val addressLines: List<String> = emptyList(),
  val phone: String? = null,
)

data class ReceiptItem(
  val description: String,
  val quantity: Int,
  val unitPrice: Money,
  val lineTotal: Money,
)

data class ReceiptTender(
  /** "cash", "card". Shown to the customer, so it is a word, not a code. */
  val method: String,
  val amount: Money,
)

/**
 * Everything a sale receipt says.
 *
 * A plain value so it can be built from a cart at the counter or from a stored
 * sale a week later — reprinting a receipt must produce the same paper, and it
 * cannot if reprinting goes through a different code path.
 */
data class SaleReceipt(
  val store: ReceiptStore,
  val receiptNo: String,
  val soldAt: Instant,
  val cashierName: String,
  val registerName: String,
  val items: List<ReceiptItem>,
  val subtotal: Money,
  val discount: Money = Money.ZERO,
  val tax: Money,
  val total: Money,
  val tenders: List<ReceiptTender>,
  val change: Money = Money.ZERO,
  /**
   * The highest age restriction on the sale, and whether ID was checked.
   *
   * Deliberately **only** these two facts. The receipt records that the check
   * happened, because that is the shop's own evidence if it is ever asked, and
   * a receipt is the one document a customer keeps. It carries no date of
   * birth, no licence number and no name: none of that is needed to show the
   * check was done, and printing it puts a customer's identity document on a
   * slip of paper that ends up in a bin behind the counter.
   */
  val minimumAge: Int? = null,
  val ageVerified: Boolean = false,
  /** Return policy and anything else the shop wants at the bottom. */
  val footer: List<String> = emptyList(),
  val reprint: Boolean = false,
)

/**
 * Turning a sale into a receipt document.
 *
 * Pure. No Android, no printer, no formatting to a width — that belongs to
 * whatever renders the document, and keeping it out of here is what lets the
 * same receipt go to paper, to a screen and to an email.
 */
object ReceiptRenderer {

  private val timestamp: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")

  fun render(receipt: SaleReceipt, zone: ZoneId = ZoneId.systemDefault()): ReceiptDocument {
    val elements = buildList {
      add(ReceiptElement.Text(receipt.store.name, Align.Center, Emphasis.Bold))
      receipt.store.addressLines.forEach {
        add(ReceiptElement.Text(it, Align.Center))
      }
      receipt.store.phone?.let { add(ReceiptElement.Text(it, Align.Center)) }

      add(ReceiptElement.Blank)

      // A reprint says so, at the top, where it cannot be missed. A duplicate
      // receipt that looks identical to the original is a refund waiting to be
      // taken twice.
      if (receipt.reprint) {
        add(ReceiptElement.Text("*** REPRINT ***", Align.Center, Emphasis.Bold))
        add(ReceiptElement.Blank)
      }

      add(ReceiptElement.Row(receipt.receiptNo, timestamp.format(receipt.soldAt.atZone(zone))))
      add(ReceiptElement.Row(receipt.registerName, receipt.cashierName))

      add(ReceiptElement.Separator)

      receipt.items.forEach { item ->
        add(
          ReceiptElement.Item(
            description = item.description,
            quantity = item.quantity,
            unitPrice = item.unitPrice.toMajorString(),
            lineTotal = item.lineTotal.toMajorString(),
          ),
        )
      }

      add(ReceiptElement.Separator)

      add(ReceiptElement.Row("Subtotal", receipt.subtotal.toMajorString()))
      if (!receipt.discount.isZero) {
        add(ReceiptElement.Row("Discount", receipt.discount.toMajorString()))
      }
      add(ReceiptElement.Row("Tax", receipt.tax.toMajorString()))
      add(ReceiptElement.Row("TOTAL", receipt.total.toMajorString(), Emphasis.Large))

      add(ReceiptElement.Blank)

      receipt.tenders.forEach { tender ->
        add(ReceiptElement.Row(tender.method.replaceFirstChar(Char::uppercase), tender.amount.toMajorString()))
      }
      if (!receipt.change.isZero) {
        add(ReceiptElement.Row("Change", receipt.change.toMajorString(), Emphasis.Bold))
      }

      // The age check, as a fact and nothing more.
      if (receipt.minimumAge != null && receipt.ageVerified) {
        add(ReceiptElement.Blank)
        add(ReceiptElement.Text("Age ${receipt.minimumAge}+ ID verified", Align.Center))
      }

      if (receipt.footer.isNotEmpty()) {
        add(ReceiptElement.Blank)
        receipt.footer.forEach { add(ReceiptElement.Text(it, Align.Center)) }
      }

      add(ReceiptElement.Blank)
      add(ReceiptElement.Barcode(receipt.receiptNo))
    }

    return ReceiptDocument(elements)
  }
}

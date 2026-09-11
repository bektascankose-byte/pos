package com.snappos.domain

/**
 * A receipt, described rather than formatted.
 *
 * The renderer produces this; a driver turns it into paper. Nothing here knows
 * a column width, a character set or a printer command, and that is the whole
 * point: the same document prints to a 58mm belt printer, an 80mm counter
 * printer, or a PNG for an emailed receipt, and a shop that changes printer
 * does not change what a receipt says.
 *
 * Pre-formatted text would collapse that. A 32 column string padded at render
 * time is wrong on every other width, and the only way back is a second
 * template that drifts from the first.
 */
data class ReceiptDocument(val elements: List<ReceiptElement>)

enum class Align { Left, Center, Right }

/** Emphasis is a hint. A printer without bold renders it as ordinary text. */
enum class Emphasis { Normal, Bold, Large }

sealed interface ReceiptElement {

  data class Text(
    val value: String,
    val align: Align = Align.Left,
    val emphasis: Emphasis = Emphasis.Normal,
  ) : ReceiptElement

  /**
   * A label on the left and an amount on the right, which is most of a receipt.
   *
   * Kept as two fields rather than one padded string so the amount can be right
   * aligned to whatever width the paper actually is.
   */
  data class Row(
    val label: String,
    val amount: String,
    val emphasis: Emphasis = Emphasis.Normal,
  ) : ReceiptElement

  /**
   * A sold line.
   *
   * Quantity and unit price are separate from the total because at more than
   * one unit a customer checks the arithmetic, and "2 @ 24.99" is what they
   * check it against.
   */
  data class Item(
    val description: String,
    val quantity: Int,
    val unitPrice: String,
    val lineTotal: String,
  ) : ReceiptElement

  data object Separator : ReceiptElement

  data object Blank : ReceiptElement

  /**
   * The receipt number, machine readable.
   *
   * A return starts by finding the original sale, and a cashier typing
   * `HH01-R1-1187` off a faded thermal receipt gets it wrong often enough to
   * matter. Printers that cannot render a barcode fall back to the text, which
   * is why the value travels as a string rather than as an image.
   */
  data class Barcode(val value: String) : ReceiptElement
}

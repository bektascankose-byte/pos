package com.snappos.domain

/**
 * Paper widths, in characters at the printer's default font.
 *
 * The two that matter: 58mm belt printers give 32 columns, 80mm counter
 * printers give 48. Both are values rather than templates, because the
 * difference between them is arithmetic and not a different receipt.
 */
enum class PaperWidth(val columns: Int) {
  Mm58(32),
  Mm80(48),
}

/**
 * A `ReceiptDocument` as monospaced lines.
 *
 * This is what a thermal printer prints and what the on-screen receipt shows,
 * deliberately the same code: a receipt a cashier reads on the till and a
 * receipt the customer is handed must agree, and the cheapest way to guarantee
 * that is for there to be one renderer.
 *
 * Amounts are right aligned to the last column. A receipt is read by running a
 * finger down the right hand edge, and a column that wanders because a
 * description was long is a receipt nobody can check.
 */
object TextReceipt {

  fun render(document: ReceiptDocument, width: PaperWidth): List<String> =
    document.elements.flatMap { render(it, width.columns) }

  private fun render(element: ReceiptElement, columns: Int): List<String> = when (element) {
    is ReceiptElement.Blank -> listOf("")

    is ReceiptElement.Separator -> listOf("-".repeat(columns))

    is ReceiptElement.Text -> wrap(element.value, columns).map { align(it, columns, element.align) }

    is ReceiptElement.Row -> listOf(row(element.label, element.amount, columns))

    is ReceiptElement.Item -> item(element, columns)

    // Rendered as text here. A driver that can print a real barcode replaces
    // this; one that cannot still prints something a cashier can read out.
    is ReceiptElement.Barcode -> listOf(align(element.value, columns, Align.Center))
  }

  /**
   * Label left, amount right, on one line.
   *
   * If the label is too long to leave room for the amount it is truncated
   * rather than wrapped: the amount is the part that must survive, and a
   * wrapped label pushes it onto a line of its own where it stops lining up
   * with every other amount on the receipt.
   */
  private fun row(label: String, amount: String, columns: Int): String {
    val room = columns - amount.length - 1
    if (room <= 0) return amount.takeLast(columns)
    val shown = if (label.length > room) label.take(room) else label
    return shown + " ".repeat(columns - shown.length - amount.length) + amount
  }

  /**
   * A sold line: description, then quantity and unit price when there is more
   * than one, then the line total on the right.
   *
   * At quantity one the "1 @ 24.99" line is noise — the description and the
   * amount already say everything — so it is omitted.
   */
  private fun item(element: ReceiptElement.Item, columns: Int): List<String> = buildList {
    val descriptionLines = wrap(element.description, columns - element.lineTotal.length - 1)

    // The total sits on the first line, beside the start of the description.
    add(row(descriptionLines.first(), element.lineTotal, columns))
    descriptionLines.drop(1).forEach { add(it) }

    if (element.quantity != 1) {
      add("  ${element.quantity} @ ${element.unitPrice}")
    }
  }

  private fun align(text: String, columns: Int, align: Align): String {
    if (text.length >= columns) return text.take(columns)
    val slack = columns - text.length
    return when (align) {
      Align.Left -> text
      Align.Right -> " ".repeat(slack) + text
      Align.Center -> " ".repeat(slack / 2) + text
    }
  }

  /**
   * Wrap on word boundaries, breaking a word only when it cannot fit at all.
   *
   * Product names are long — "Geek Bar Pulse X - Miami Mint" does not fit 32
   * columns — and breaking mid-word makes a receipt look broken rather than
   * narrow.
   */
  private fun wrap(text: String, columns: Int): List<String> {
    if (columns <= 0) return listOf(text)
    if (text.length <= columns) return listOf(text)

    val lines = mutableListOf<String>()
    var current = StringBuilder()

    for (word in text.split(' ')) {
      when {
        current.isEmpty() && word.length > columns -> {
          // A single word longer than the paper. Break it; there is no
          // alternative that keeps the receipt readable.
          word.chunked(columns).forEach { lines.add(it) }
          if (lines.isNotEmpty() && lines.last().length < columns) {
            current = StringBuilder(lines.removeAt(lines.lastIndex))
          }
        }
        current.isEmpty() -> current.append(word)
        current.length + 1 + word.length <= columns -> current.append(' ').append(word)
        else -> {
          lines.add(current.toString())
          current = StringBuilder(word)
        }
      }
    }
    if (current.isNotEmpty()) lines.add(current.toString())
    return lines
  }
}

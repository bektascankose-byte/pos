package com.snappos.hardware

import com.snappos.domain.ReceiptDocument

/**
 * Where a receipt can go.
 *
 * Named by capability rather than by device. Checkout asks for a printer; it
 * does not know or care whether that resolves to an Epson on ethernet, a Sunmi
 * built-in head, or nothing at all.
 */
enum class PrinterKind { Receipt, Label }

/**
 * What a printer can do right now.
 *
 * `ready` is the only field checkout looks at, and it looks at it to decide
 * what to *tell the cashier* — never to decide whether the sale may complete.
 */
data class PrinterStatus(
  val ready: Boolean,
  val kind: PrinterKind = PrinterKind.Receipt,
  /** Shown to a cashier, so it is a sentence: "Out of paper", not "E_NOPAPER". */
  val detail: String? = null,
  val canOpenDrawer: Boolean = false,
)

sealed interface PrintResult {
  data object Printed : PrintResult

  /**
   * The printer was reachable and refused, or was not reachable at all.
   *
   * A failure, not an exception. See the contract on [PrinterProvider.print].
   */
  data class Failed(val reason: String, val retryable: Boolean = true) : PrintResult

  /** No printer is configured. Not an error: plenty of registers have none. */
  data object NoPrinter : PrintResult
}

/**
 * A printer, as the sale path is allowed to see it.
 *
 * **Printing must never be able to fail a sale.** The money has changed hands
 * by the time a receipt is produced; a printer that is out of paper, unplugged,
 * or whose vendor SDK throws on a Tuesday cannot be allowed to roll that back
 * or to leave the cashier stuck. So every method here reports rather than
 * throws, and the caller is expected to carry on regardless.
 *
 * That is also why this module has no implementation in it. Interfaces only,
 * no vendor SDK, no Android dependency — the sale path physically cannot
 * reference a concrete device.
 */
interface PrinterProvider {

  /**
   * Print a receipt.
   *
   * Takes the abstract document rather than text: the driver knows its own
   * paper width and character set, and rasterising in the driver is what lets
   * one receipt print correctly at 58mm, at 80mm, and as an image for email.
   *
   * Implementations must not throw. Anything that goes wrong comes back as
   * [PrintResult.Failed].
   */
  suspend fun print(document: ReceiptDocument): PrintResult

  /**
   * Kick the cash drawer.
   *
   * On most counters the drawer is wired to the printer and opens via its kick
   * command, which is why this lives here rather than on a drawer of its own.
   * A register with a standalone drawer gets its own adapter.
   */
  suspend fun openDrawer(): PrintResult

  suspend fun status(): PrinterStatus
}

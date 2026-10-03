package com.snappos.data

import com.snappos.data.dao.ConfigDao
import com.snappos.data.dao.EmployeeDao
import com.snappos.data.dao.SalesDao
import com.snappos.data.entities.SaleEntity
import com.snappos.domain.Money
import com.snappos.domain.ReceiptItem
import com.snappos.domain.ReceiptStore
import com.snappos.domain.ReceiptTender
import com.snappos.domain.SaleReceipt
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import javax.inject.Inject
import javax.inject.Singleton

/** One line in the list of a day's receipts. */
data class ReceiptSummary(
  val saleId: String,
  val receiptNo: String,
  val soldAtMillis: Long,
  val total: Money,
  /** "cash", "card", "other", or several joined, as the slip would read. */
  val tenders: String,
  val itemCount: Int,
  val voided: Boolean,
)

/**
 * The receipts this register has taken, to look back over.
 *
 * Entirely local. A cashier asked for a copy of a receipt is standing in
 * front of a customer, and whether the shop's internet is up has nothing to
 * do with whether that receipt exists: it was rung here, it is stored here,
 * and it is read back from here.
 *
 * Reprinting rebuilds the receipt from what was stored rather than keeping a
 * rendered copy, which is what `SaleReceipt` was shaped for -- "built from a
 * cart at the counter or from a stored sale a week later". The columns it
 * reads are the ones a completed sale may never change, so the paper that
 * comes out second is the paper that came out first.
 */
@Singleton
class ReceiptHistory @Inject constructor(
  private val sales: SalesDao,
  private val config: ConfigDao,
  private val employees: EmployeeDao,
) {

  /** Every receipt taken on a given day, newest first. */
  suspend fun onDay(day: LocalDate, zone: ZoneId = ZoneId.systemDefault()): List<ReceiptSummary> {
    val from = day.atStartOfDay(zone).toInstant().toEpochMilli()
    val to = day.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
    return sales.onDay(from, to).map { summarise(it) }
  }

  /** One receipt by the number printed on it. Null when this register never rang it. */
  suspend fun byReceiptNo(receiptNo: String): ReceiptSummary? {
    val sale = sales.byReceiptNo(receiptNo.trim()) ?: return null
    return summarise(sale)
  }

  /**
   * Rebuild a stored sale into the receipt it was.
   *
   * Null for a sale whose lines are missing, which should not happen -- they
   * are written in the same transaction -- but handing back half a receipt
   * would be worse than handing back none.
   */
  suspend fun receiptFor(saleId: String): SaleReceipt? {
    val sale = sales.byId(saleId) ?: return null
    val lines = sales.linesFor(saleId)
    if (lines.isEmpty()) return null
    val payments = sales.paymentsFor(saleId)
    val registerConfig = config.get()

    return SaleReceipt(
      store = ReceiptStore(name = registerConfig?.storeName ?: "SnapPOS"),
      receiptNo = sale.receiptNo,
      // When it was sold, not when it is being reprinted. A copy of a
      // receipt that claims today's date is a different document.
      soldAt = Instant.ofEpochMilli(sale.completedAtMillis ?: sale.deviceTimeMillis),
      // Whoever rang it, not whoever is signed in now. A receipt reprinted
      // on the next shift still names the cashier who took the money.
      cashierName = employees.byId(sale.cashierUserId)?.displayName.orEmpty(),
      registerName = "Register ${registerConfig?.registerCode ?: ""}".trim(),
      items = lines.map { line ->
        ReceiptItem(
          description = line.description,
          quantity = line.quantity.toIntOrNull() ?: 1,
          unitPrice = Money.ofMinor(line.unitPriceMinor),
          lineTotal = Money.ofMinor(line.totalMinor),
        )
      },
      subtotal = Money.ofMinor(sale.subtotalMinor),
      discount = Money.ofMinor(sale.discountMinor),
      tax = Money.ofMinor(sale.taxMinor),
      total = Money.ofMinor(sale.totalMinor),
      // Cash shows what was handed over, the same as it did on the night,
      // so the reprint and the original agree line for line.
      tenders = payments.map {
        ReceiptTender(
          if (it.method == "external") "other" else it.method,
          Money.ofMinor(it.tenderedMinor ?: it.amountMinor),
        )
      },
      change = Money.ofMinor(payments.sumOf { it.changeMinor }),
      // Not reconstructed from the age checks table: what the receipt said
      // is a fact about that night, and the only honest source for it on a
      // reprint is the line's own compliance snapshot.
      minimumAge = lines.mapNotNull { minimumAgeIn(it.complianceSnapshotJson) }.maxOrNull(),
      ageVerified = lines.any { minimumAgeIn(it.complianceSnapshotJson) != null },
    )
  }

  private suspend fun summarise(sale: SaleEntity): ReceiptSummary {
    val payments = sales.paymentsFor(sale.id)
    val lines = sales.linesFor(sale.id)
    return ReceiptSummary(
      saleId = sale.id,
      receiptNo = sale.receiptNo,
      soldAtMillis = sale.completedAtMillis ?: sale.deviceTimeMillis,
      total = Money.ofMinor(sale.totalMinor),
      tenders = payments
        .map { if (it.method == "external") "other" else it.method }
        .distinct()
        .joinToString(", ")
        .ifEmpty { "—" },
      itemCount = lines.size,
      voided = sale.status == "voided",
    )
  }

  /** The age gate recorded on a line, when there was one. */
  private fun minimumAgeIn(json: String): Int? =
    MINIMUM_AGE.find(json)?.groupValues?.get(1)?.toIntOrNull()

  private companion object {
    val MINIMUM_AGE = Regex("\"minimum_age\"\\s*:\\s*(\\d+)")
  }
}

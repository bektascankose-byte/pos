package com.snappos.data

import com.snappos.data.dao.ConfigDao
import com.snappos.data.dao.RefundsDao
import com.snappos.data.entities.OutboxEntity
import com.snappos.data.entities.RefundEntity
import com.snappos.data.entities.RefundLineEntity
import com.snappos.domain.Money
import com.snappos.domain.Uuid7
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.abs

/** A line on the original sale, with what is still returnable. */
data class RefundableLine(
  val saleLineId: String,
  val variantId: String,
  val description: String,
  val sku: String,
  val sold: Double,
  val alreadyRefunded: Double,
  val unitPrice: Money,
  val taxPerUnit: Money,
  val unitCost: String,
) {
  val refundable: Double get() = sold - alreadyRefunded
  val fullyRefunded: Boolean get() = refundable <= 0.0001
}

data class RefundableSale(
  val saleId: String,
  val receiptNo: String,
  val completedAtMillis: Long,
  val totalMinor: Long,
  val lines: List<RefundableLine>,
) {
  val fullyRefunded: Boolean get() = lines.all { it.fullyRefunded }
}

/** What the cashier chose to hand back. */
data class RefundSelection(
  val saleLineId: String,
  val quantity: Int,
  val restock: Boolean = true,
  val condition: String? = null,
)

data class CommittedRefund(
  val refundId: String,
  val receiptNo: String,
  val total: Money,
)

/**
 * Refunds, on the device.
 *
 * A refund is the single most common vector for employee theft in retail, so
 * three things are true of every one composed here:
 *
 *   * it names the original sale, so a quantity can be checked
 *   * it names the manager who approved it
 *   * the units it returns are claimed against the original line, so the same
 *     item cannot be handed back twice
 *
 * The third check is done locally **and** on the server. The local copy of
 * `quantityRefunded` is advisory — another register can refund the same receipt
 * while this one is offline, and only the server knows that — but catching an
 * over-refund at the counter is infinitely better than catching it on upload,
 * when the customer has already been handed the money.
 */
@Singleton
class RefundRepository @Inject constructor(
  private val refunds: RefundsDao,
  private val config: ConfigDao,
  private val cash: CashRepository,
) {

  private val json = Json { encodeDefaults = true }

  val unsyncedCount get() = refunds.unsyncedCount()

  /**
   * Find a sale by the number printed on its receipt.
   *
   * Local only, for now. A sale rung on another register or on a previous day
   * that has since been cleared is not on this device, and the honest answer is
   * to say so rather than to invent a refund with nothing to check it against.
   */
  suspend fun findByReceipt(receiptNo: String): RefundableSale? {
    val sale = refunds.saleByReceipt(receiptNo.trim().uppercase()) ?: return null
    if (sale.status == "voided") return null
    // A voided sale is deliberately not refundable — the money already went
    // back — but it is still on this register, and `wasVoided` exists so the
    // screen can say that rather than "no such sale", which is untrue and
    // sends the cashier looking for a receipt they are holding.

    val lines = refunds.linesFor(sale.id).map { line ->
      val sold = abs(line.quantity.toDoubleOrNull() ?: 0.0)
      val refunded = line.quantityRefunded.toDoubleOrNull() ?: 0.0
      val quantity = if (sold == 0.0) 1.0 else sold

      RefundableLine(
        saleLineId = line.id,
        variantId = line.variantId,
        description = line.description,
        sku = line.skuSnapshot,
        sold = sold,
        alreadyRefunded = refunded,
        unitPrice = Money.ofMinor(line.unitPriceMinor),
        // Tax was rounded once, on the whole line. Dividing it back out per
        // unit is the only way a partial refund can return a proportional
        // share, and the remainder is absorbed by the final unit rather than
        // silently lost.
        taxPerUnit = Money.ofMinor((line.taxMinor / quantity).toLong()),
        unitCost = line.unitCost,
      )
    }

    return RefundableSale(
      saleId = sale.id,
      receiptNo = sale.receiptNo,
      completedAtMillis = sale.completedAtMillis ?: sale.deviceTimeMillis,
      totalMinor = sale.totalMinor,
      lines = lines,
    )
  }

  /** Whether that receipt names a sale on this register that was voided. */
  suspend fun wasVoided(receiptNo: String): Boolean =
    refunds.saleByReceipt(receiptNo.trim().uppercase())?.status == "voided"

  /**
   * Commit a refund.
   *
   * @param approvedBy the manager who authorized it, already verified by PIN.
   *   Required rather than nullable: a refund with no name attached is
   *   indistinguishable from theft after the fact.
   */
  suspend fun commit(
    sale: RefundableSale,
    selections: List<RefundSelection>,
    cashierUserId: String,
    approvedBy: String,
    reasonCode: String,
    reasonNote: String? = null,
    sessionId: String? = null,
    deviceTimeMillis: Long = System.currentTimeMillis(),
  ): Result<CommittedRefund> {
    val registerConfig = config.get()
      ?: return Result.failure(IllegalStateException("this device is not provisioned"))

    if (selections.isEmpty()) {
      return Result.failure(IllegalArgumentException("nothing selected to refund"))
    }

    val byLine = sale.lines.associateBy { it.saleLineId }

    // Checked before anything is written, so a refusal leaves no trace.
    for (selection in selections) {
      val line = byLine[selection.saleLineId]
        ?: return Result.failure(IllegalArgumentException("that line is not on this sale"))
      if (selection.quantity <= 0) {
        return Result.failure(IllegalArgumentException("a refund of zero is not a refund"))
      }
      if (selection.quantity > line.refundable + 0.0001) {
        val remaining = line.refundable.toInt()
        return Result.failure(
          IllegalArgumentException(
            if (remaining > 0) {
              "Only $remaining of ${line.description} can still be refunded"
            } else {
              "${line.description} has already been fully refunded"
            },
          ),
        )
      }
    }

    val refundId = Uuid7.generate()
    val sequence = config.claimSequence()
    val receiptNo = "${registerConfig.storeCode}-${registerConfig.registerCode}-R$sequence"

    val lines = selections.map { selection ->
      val line = byLine.getValue(selection.saleLineId)
      val subtotal = line.unitPrice * selection.quantity
      val tax = line.taxPerUnit * selection.quantity

      RefundLineEntity(
        id = Uuid7.generate(),
        refundId = refundId,
        saleLineId = line.saleLineId,
        variantId = line.variantId,
        description = line.description,
        quantity = selection.quantity.toString(),
        unitPriceMinor = line.unitPrice.minor,
        taxMinor = tax.minor,
        totalMinor = (subtotal + tax).minor,
        unitCost = line.unitCost,
        restocked = selection.restock,
        condition = selection.condition,
      )
    }

    val subtotal = Money.ofMinor(
      lines.sumOf { it.totalMinor - it.taxMinor },
    )
    val tax = Money.ofMinor(lines.sumOf { it.taxMinor })
    val total = subtotal + tax

    val refund = RefundEntity(
      id = refundId,
      storeId = registerConfig.storeId,
      registerId = registerConfig.registerId,
      sessionId = sessionId,
      originalSaleId = sale.saleId,
      cashierUserId = cashierUserId,
      approvedBy = approvedBy,
      receiptNo = receiptNo,
      reasonCode = reasonCode,
      reasonNote = reasonNote,
      subtotalMinor = subtotal.minor,
      taxMinor = tax.minor,
      totalMinor = total.minor,
      restock = lines.any { it.restocked },
      deviceTimeMillis = deviceTimeMillis,
      completedAtMillis = deviceTimeMillis,
    )

    refunds.commitRefund(
      refund = refund,
      lines = lines,
      claims = selections.map { it.saleLineId to it.quantity.toString() },
      outbox = OutboxEntity(
        id = Uuid7.generate(),
        entityType = "refund",
        entityId = refundId,
        payloadJson = buildPayload(refund, lines, registerConfig.deviceId),
        deviceTimeMillis = deviceTimeMillis,
        createdAtMillis = System.currentTimeMillis(),
        state = "pending",
        attempts = 0,
        lastAttemptMillis = null,
        lastError = null,
        nextAttemptMillis = 0,
      ),
    )

    // Cash out of the drawer. Negative, because money left.
    if (sessionId != null) {
      cash.recordMovement(
        sessionId = sessionId,
        kind = "refund",
        amount = -total,
        actorUserId = cashierUserId,
        referenceType = "refund",
        referenceId = refundId,
        occurredAtMillis = deviceTimeMillis,
      )
    }

    return Result.success(CommittedRefund(refundId, receiptNo, total))
  }

  /**
   * The upload body, built once at commit time and stored.
   *
   * Not rebuilt at upload time, for the same reason a sale's is not: the
   * payload is a snapshot of what actually happened, and regenerating it later
   * would let a change in this code alter the content of a refund that has
   * already been handed over.
   */
  private fun buildPayload(
    refund: RefundEntity,
    lines: List<RefundLineEntity>,
    deviceId: String,
  ): String = json.encodeToString(
    JsonObject.serializer(),
    buildJsonObject {
      put("store_id", refund.storeId)
      put("register_id", refund.registerId)
      refund.sessionId?.let { put("session_id", it) }
      refund.originalSaleId?.let { put("original_sale_id", it) }
      put("cashier_user_id", refund.cashierUserId)
      refund.approvedBy?.let { put("approved_by", it) }
      put("receipt_no", refund.receiptNo)
      put("reason_code", refund.reasonCode)
      refund.reasonNote?.let { put("reason_note", it) }
      put("subtotal_minor", refund.subtotalMinor.toString())
      put("tax_minor", refund.taxMinor.toString())
      put("total_minor", refund.totalMinor.toString())
      put("restock", refund.restock)
      put("device_time", Iso8601.format(refund.deviceTimeMillis))
      put(
        "lines",
        buildJsonArray {
          lines.forEach { line ->
            add(
              buildJsonObject {
                put("id", line.id)
                line.saleLineId?.let { put("sale_line_id", it) }
                put("variant_id", line.variantId)
                put("description", line.description)
                put("quantity", line.quantity)
                put("unit_price_minor", line.unitPriceMinor.toString())
                put("tax_minor", line.taxMinor.toString())
                put("total_minor", line.totalMinor.toString())
                put("unit_cost", line.unitCost)
                put("restocked", line.restocked)
                line.condition?.let { put("condition", it) }
              },
            )
          }
        },
      )
      put(
        "payments",
        buildJsonArray {
          add(
            buildJsonObject {
              put("id", Uuid7.generate())
              put("method", "cash")
              put("status", "captured")
              put("amount_minor", refund.totalMinor.toString())
              put("device_time", Iso8601.format(refund.deviceTimeMillis))
            },
          )
        },
      )
    },
  )
}

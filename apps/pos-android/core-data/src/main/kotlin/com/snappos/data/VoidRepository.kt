package com.snappos.data

import com.snappos.data.dao.ConfigDao
import com.snappos.data.dao.RefundsDao
import com.snappos.data.entities.OutboxEntity
import com.snappos.domain.Money
import com.snappos.domain.Uuid7
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

data class VoidedSale(val saleId: String, val receiptNo: String, val total: Money)

/**
 * Voiding a sale, on the device.
 *
 * A void is for a whole transaction that should not have happened — the wrong
 * item rung, the customer changing their mind before leaving the counter. It
 * reverses the money and the stock at once, which is exactly why it needs a
 * manager: it is the shortest path from "a sale happened" to "no record of a
 * sale" that the register offers.
 *
 * Two rules are enforced here and again on the server, deliberately:
 *
 *   * a sale is voided once. Voiding twice would restock twice.
 *   * a partly refunded sale cannot be voided. Refunding one of two units and
 *     then voiding the whole sale would return three units of stock and more
 *     money than the customer ever paid.
 *
 * The device's copy of both is advisory — another register can refund the same
 * receipt while this one is offline — but catching either at the counter beats
 * catching it on upload, after the drawer has already been opened.
 */
@Singleton
class VoidRepository @Inject constructor(
  private val refunds: RefundsDao,
  private val config: ConfigDao,
  private val cash: CashRepository,
) {

  private val json = Json { encodeDefaults = true }

  /**
   * Void a sale.
   *
   * @param approvedBy the manager who authorised it, already verified by PIN.
   *   Required rather than nullable, for the same reason a refund's is.
   */
  suspend fun commit(
    sale: RefundableSale,
    cashierUserId: String,
    approvedBy: String,
    reason: String,
    sessionId: String? = null,
    deviceTimeMillis: Long = System.currentTimeMillis(),
  ): Result<VoidedSale> {
    // A provisioning guard, not a value we need: an unprovisioned device has no
    // store to attribute the void to and nothing to upload it with.
    config.get()
      ?: return Result.failure(IllegalStateException("this device is not provisioned"))

    val row = refunds.saleById(sale.saleId)
      ?: return Result.failure(IllegalArgumentException("that sale is not on this register"))

    // Checked before anything is written, so a refusal leaves no trace.
    if (row.status == "voided") {
      return Result.failure(IllegalStateException("${sale.receiptNo} has already been voided"))
    }
    if (sale.lines.any { it.alreadyRefunded > 0.0001 }) {
      return Result.failure(
        IllegalStateException(
          "Part of ${sale.receiptNo} was already refunded. Refund the rest instead of voiding.",
        ),
      )
    }

    val voidId = Uuid7.generate()

    val marked = refunds.commitVoid(
      saleId = sale.saleId,
      voidedAtMillis = deviceTimeMillis,
      voidedBy = approvedBy,
      reason = reason,
      outbox = OutboxEntity(
        id = Uuid7.generate(),
        entityType = "sale_void",
        entityId = voidId,
        payloadJson = buildPayload(voidId, sale.saleId, cashierUserId, approvedBy, reason, deviceTimeMillis),
        deviceTimeMillis = deviceTimeMillis,
        createdAtMillis = System.currentTimeMillis(),
        state = "pending",
        attempts = 0,
        lastAttemptMillis = null,
        lastError = null,
        nextAttemptMillis = 0,
      ),
    )

    if (!marked) {
      return Result.failure(
        IllegalStateException("${sale.receiptNo} was voided a moment ago on this register"),
      )
    }

    // The money comes back out of the drawer, exactly as it does on the server.
    //
    // Only the cash tenders, and only what actually went in. Without this the
    // drawer is expected to hold money that was handed back, so every voided
    // cash sale reads over by its own amount at close — and over is the signal
    // a manager is meant to be able to trust.
    if (sessionId != null) {
      for (payment in refunds.cashPaymentsFor(sale.saleId)) {
        cash.recordMovement(
          sessionId = sessionId,
          kind = "refund",
          amount = Money.ofMinor(-payment.amountMinor),
          actorUserId = cashierUserId,
          reason = reason,
          referenceType = "sale_void",
          referenceId = sale.saleId,
          occurredAtMillis = deviceTimeMillis,
        )
      }
    }

    return Result.success(
      VoidedSale(sale.saleId, sale.receiptNo, Money.ofMinor(sale.totalMinor)),
    )
  }

  /**
   * The upload body, built once at commit time and stored.
   *
   * Not rebuilt at upload time, for the same reason a sale's and a refund's are
   * not: the payload is a snapshot of what actually happened, and regenerating
   * it later would let a change in this code alter the content of a void that
   * has already been given effect at the counter.
   */
  private fun buildPayload(
    voidId: String,
    saleId: String,
    cashierUserId: String,
    approvedBy: String,
    reason: String,
    deviceTimeMillis: Long,
  ): String = json.encodeToString(
    JsonObject.serializer(),
    buildJsonObject {
      put("id", voidId)
      put("sale_id", saleId)
      put("cashier_user_id", cashierUserId)
      put("approved_by", approvedBy)
      put("reason", reason)
      put("device_time", Iso8601.format(deviceTimeMillis))
    },
  )
}

package com.snappos.data

import com.snappos.data.dao.ConfigDao
import com.snappos.data.dao.OutboxDao
import com.snappos.data.dao.SalesDao
import com.snappos.data.entities.AgeVerificationEntity
import com.snappos.data.entities.OutboxEntity
import com.snappos.data.entities.PaymentEntity
import com.snappos.data.entities.SaleEntity
import com.snappos.data.entities.SaleLineEntity
import com.snappos.domain.Cart
import com.snappos.domain.Money
import com.snappos.domain.Uuid7
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

/** How a customer paid. */
data class Tender(
  val method: String,
  val amount: Money,
  val tendered: Money? = null,
  val change: Money = Money.ZERO,
  val providerToken: String? = null,
  val cardLast4: String? = null,
  val cardBrand: String? = null,
  val authCode: String? = null,
)

data class CommittedSale(
  val saleId: String,
  val receiptNo: String,
  val total: Money,
  val change: Money,
)

/**
 * Turning a cart into a sale.
 *
 * This is the moment the architecture is really about. The cashier taps PAY and
 * everything below happens on device, in one local transaction, with **zero
 * network time**:
 *
 *   1. the sale id is minted here as a UUIDv7 — never asked of a server
 *   2. the receipt number is composed from store, register and a local sequence
 *   3. the sale, its lines, its tenders and its age checks are written
 *   4. an outbox row is written in the same transaction
 *   5. the receipt prints and the cashier is done
 *
 * The upload happens later, whenever the network happens to exist, and can be
 * retried as rudely as it likes: the id was fixed before the first attempt, so
 * server intake conflicts and a duplicate delivery cannot become a duplicate
 * sale.
 */
@Singleton
class SaleRepository @Inject constructor(
  private val sales: SalesDao,
  private val outbox: OutboxDao,
  private val config: ConfigDao,
) {

  private val json = Json { encodeDefaults = true }

  val unsyncedCount: Flow<Int> get() = sales.unsyncedCount()
  val pendingUploads: Flow<Int> get() = outbox.pendingCount()
  val deadLetters: Flow<Int> get() = outbox.deadCount()

  fun recentSales(limit: Int = 50): Flow<List<SaleEntity>> = sales.recent(limit)

  /**
   * Commit a sale.
   *
   * @param deviceTimeMillis passed in rather than read from the clock so the
   *   same instant is used for the sale, its lines and its ledger entries. The
   *   server derives ledger ids from these, and two calls to `now()` a
   *   millisecond apart would produce two different keys for one sale.
   */
  suspend fun commit(
    cart: Cart,
    tenders: List<Tender>,
    sessionId: String?,
    deviceTimeMillis: Long = System.currentTimeMillis(),
  ): CommittedSale {
    val registerConfig = requireNotNull(config.get()) {
      "this device has not been claimed by a register"
    }
    val cashierUserId = requireNotNull(registerConfig.cashierUserId) {
      "no cashier is signed in on this register"
    }

    val saleId = Uuid7.generate()
    val sequence = config.claimSequence()
    val receiptNo = "${registerConfig.storeCode}-${registerConfig.registerCode}-$sequence"

    val lines = cart.effectiveLines
    val change = Money.sum(tenders.map { it.change })

    val saleEntity = SaleEntity(
      id = saleId,
      storeId = registerConfig.storeId,
      registerId = registerConfig.registerId,
      sessionId = sessionId,
      cashierUserId = cashierUserId,
      customerId = cart.customerId,
      receiptNo = receiptNo,
      registerSequence = sequence,
      status = "completed",
      subtotalMinor = cart.subtotal.minor,
      discountMinor = cart.discountTotal.minor,
      taxMinor = cart.taxTotal.minor,
      tipMinor = cart.tip.minor,
      totalMinor = cart.total.minor,
      taxExempt = cart.taxExempt,
      taxExemptReason = cart.taxExemptReason,
      note = cart.note,
      deviceTimeMillis = deviceTimeMillis,
      completedAtMillis = deviceTimeMillis,
      syncState = "pending",
    )

    val lineEntities = lines.map { line ->
      SaleLineEntity(
        // The line's own id becomes the server's inventory ledger id. Fixed
        // here, before any upload, which is what makes a replayed sync collide
        // instead of deducting stock a second time.
        id = line.id,
        saleId = saleId,
        lineNo = line.lineNo,
        variantId = line.variantId,
        description = line.description,
        skuSnapshot = line.sku,
        barcodeScanned = line.barcodeScanned,
        quantity = line.quantity.toString(),
        unitPriceMinor = line.unitPrice.minor,
        originalPriceMinor = line.catalogPrice.minor,
        priceOverridden = line.isPriceOverridden,
        overrideBy = line.priceOverriddenBy,
        overrideReason = line.overrideReason,
        discountMinor = line.discount.minor,
        taxMinor = line.tax.minor,
        totalMinor = line.total.minor,
        unitCost = line.unitCost,
        taxSnapshotJson = json.encodeToString(
          JsonArray.serializer(),
          buildJsonArray {
            line.taxBreakdown().forEach { component ->
              add(
                buildJsonObject {
                  put("name", component.name)
                  put("rate", component.rate)
                  put("amount_minor", component.amount.serialize())
                },
              )
            }
          },
        ),
        complianceSnapshotJson = json.encodeToString(
          JsonObject.serializer(),
          buildJsonObject {
            line.minimumAge?.let { put("minimum_age", it) }
            put("id_scan_required", line.idScanRequired)
          },
        ),
      )
    }

    val paymentEntities = tenders.map { tender ->
      PaymentEntity(
        id = Uuid7.generate(),
        saleId = saleId,
        method = tender.method,
        status = "captured",
        amountMinor = tender.amount.minor,
        tenderedMinor = tender.tendered?.minor,
        changeMinor = tender.change.minor,
        tipMinor = 0,
        provider = null,
        providerPaymentId = null,
        providerToken = tender.providerToken,
        cardLast4 = tender.cardLast4,
        cardBrand = tender.cardBrand,
        authCode = tender.authCode,
        deviceTimeMillis = deviceTimeMillis,
      )
    }

    val ageChecks = if (lines.any { it.minimumAge != null }) {
      listOf(
        AgeVerificationEntity(
          id = Uuid7.generate(),
          saleId = saleId,
          saleLineId = lines.first { it.minimumAge != null }.id,
          method = "manual",
          result = "pass",
          minimumAgeApplied = cart.minimumAgeRequired ?: 21,
          verifiedAtMillis = deviceTimeMillis,
        ),
      )
    } else {
      emptyList()
    }

    val payload = buildSalePayload(
      saleEntity, lineEntities, paymentEntities, ageChecks, registerConfig.deviceId,
    )

    val outboxEntry = OutboxEntity(
      id = Uuid7.generate(),
      entityType = "sale",
      // The sale's own id is its idempotency key. There is no separate key to
      // get wrong and no way to submit one sale under two identities.
      entityId = saleId,
      payloadJson = payload,
      deviceTimeMillis = deviceTimeMillis,
      createdAtMillis = System.currentTimeMillis(),
      state = "pending",
      attempts = 0,
      lastAttemptMillis = null,
      lastError = null,
      nextAttemptMillis = 0,
    )

    // One transaction. Either all of it lands or none of it does.
    sales.commitSale(saleEntity, lineEntities, paymentEntities, ageChecks, outboxEntry)

    return CommittedSale(saleId, receiptNo, cart.total, change)
  }

  /**
   * The upload body, built once at commit time and stored.
   *
   * Deliberately not rebuilt at upload time from the local rows. The payload is
   * a snapshot of what was actually charged; regenerating it later would let a
   * change in this code silently alter the content of a sale that has already
   * happened.
   */
  private fun buildSalePayload(
    sale: SaleEntity,
    lines: List<SaleLineEntity>,
    payments: List<PaymentEntity>,
    ageChecks: List<AgeVerificationEntity>,
    deviceId: String,
  ): String = json.encodeToString(
    JsonObject.serializer(),
    buildJsonObject {
      put("store_id", sale.storeId)
      put("register_id", sale.registerId)
      put("device_id", deviceId)
      sale.sessionId?.let { put("session_id", it) }
      put("cashier_user_id", sale.cashierUserId)
      sale.customerId?.let { put("customer_id", it) }
      put("receipt_no", sale.receiptNo)
      put("register_sequence", sale.registerSequence)
      put("status", sale.status)
      put("subtotal_minor", sale.subtotalMinor.toString())
      put("discount_minor", sale.discountMinor.toString())
      put("tax_minor", sale.taxMinor.toString())
      put("tip_minor", sale.tipMinor.toString())
      put("total_minor", sale.totalMinor.toString())
      put("tax_exempt", sale.taxExempt)
      sale.taxExemptReason?.let { put("tax_exempt_reason", it) }
      sale.note?.let { put("note", it) }
      put("device_time", Iso8601.format(sale.deviceTimeMillis))
      sale.completedAtMillis?.let { put("completed_at", Iso8601.format(it)) }

      put(
        "lines",
        buildJsonArray {
          lines.forEach { line ->
            add(
              buildJsonObject {
                put("id", line.id)
                put("line_no", line.lineNo)
                put("variant_id", line.variantId)
                put("description", line.description)
                put("sku_snapshot", line.skuSnapshot)
                line.barcodeScanned?.let { put("barcode_scanned", it) }
                put("quantity", line.quantity)
                put("unit_price_minor", line.unitPriceMinor.toString())
                put("original_price_minor", line.originalPriceMinor.toString())
                put("price_overridden", line.priceOverridden)
                line.overrideBy?.let { put("override_by", it) }
                line.overrideReason?.let { put("override_reason", it) }
                put("discount_minor", line.discountMinor.toString())
                put("tax_minor", line.taxMinor.toString())
                put("total_minor", line.totalMinor.toString())
                put("unit_cost", line.unitCost)
                put("tax_snapshot", json.parseToJsonElement(line.taxSnapshotJson))
                put("compliance_snapshot", json.parseToJsonElement(line.complianceSnapshotJson))
              },
            )
          }
        },
      )

      put(
        "payments",
        buildJsonArray {
          payments.forEach { payment ->
            add(
              buildJsonObject {
                put("id", payment.id)
                put("method", payment.method)
                put("status", payment.status)
                put("amount_minor", payment.amountMinor.toString())
                payment.tenderedMinor?.let { put("tendered_minor", it.toString()) }
                put("change_minor", payment.changeMinor.toString())
                put("tip_minor", payment.tipMinor.toString())
                payment.providerToken?.let { put("provider_token", it) }
                payment.cardLast4?.let { put("card_last4", it) }
                payment.cardBrand?.let { put("card_brand", it) }
                payment.authCode?.let { put("auth_code", it) }
                put("device_time", Iso8601.format(payment.deviceTimeMillis))
              },
            )
          }
        },
      )

      put(
        "age_verifications",
        buildJsonArray {
          ageChecks.forEach { check ->
            add(
              buildJsonObject {
                put("id", check.id)
                check.saleLineId?.let { put("sale_line_id", it) }
                put("method", check.method)
                put("result", check.result)
                put("minimum_age_applied", check.minimumAgeApplied)
                put("verified_at", Iso8601.format(check.verifiedAtMillis))
              },
            )
          }
        },
      )
    },
  )
}


/**
 * ISO 8601 with an offset, which is what the server's contracts require.
 *
 * A naive local timestamp is ambiguous, and on a register the ambiguity is not
 * theoretical: a shop open across a daylight saving change would produce an
 * hour of sales that cannot be ordered.
 */
internal object Iso8601 {
  fun format(millis: Long): String =
    java.time.Instant.ofEpochMilli(millis)
      .atZone(java.time.ZoneId.systemDefault())
      .format(java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME)
}

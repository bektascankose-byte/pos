package com.snappos.data

import com.snappos.data.dao.HoldsDao
import com.snappos.data.entities.HeldCartEntity
import com.snappos.data.entities.HeldCartLineEntity
import com.snappos.domain.Cart
import com.snappos.domain.CartDiscount
import com.snappos.domain.CartLine
import com.snappos.domain.LineAdjustment
import com.snappos.domain.Money
import com.snappos.domain.Uuid7
import javax.inject.Inject
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

data class HeldCartSummary(
  val id: String,
  val label: String,
  val itemCount: Int,
  val total: Money,
  val updatedAtMillis: Long,
)

class HoldRepository @Inject constructor(private val dao: HoldsDao) {
  private val json = Json { ignoreUnknownKeys = false }

  fun observe(): Flow<List<HeldCartEntity>> = dao.observeAll()

  suspend fun hold(cart: Cart, label: String, cashierUserId: String): String {
    require(!cart.isEmpty) { "an empty sale cannot be held" }
    require(label.isNotBlank()) { "a held sale needs a label" }
    val id = Uuid7.generate()
    val now = System.currentTimeMillis()
    dao.save(
      HeldCartEntity(
        id = id,
        label = label.trim().take(80),
        cashierUserId = cashierUserId,
        customerId = cart.customerId,
        taxExempt = cart.taxExempt,
        taxExemptReason = cart.taxExemptReason,
        note = cart.note,
        cartDiscountMinor = cart.cartDiscount?.amount?.minor,
        cartDiscountReason = cart.cartDiscount?.reason,
        tipMinor = cart.tip.minor,
        createdAtMillis = now,
        updatedAtMillis = now,
      ),
      cart.lines.map { line -> line.toEntity(id) },
    )
    return id
  }

  /** Taking is atomic: a held basket can never be resumed twice on one register. */
  suspend fun resume(id: String): Cart? {
    val (held, lines) = dao.take(id) ?: return null
    return Cart(
      lines = lines.map { it.toDomain() },
      cartDiscount = held.cartDiscountMinor?.let {
        CartDiscount(Money.ofMinor(it), held.cartDiscountReason ?: "held_cart_discount")
      },
      tip = Money.ofMinor(held.tipMinor),
      customerId = held.customerId,
      taxExempt = held.taxExempt,
      taxExemptReason = held.taxExemptReason,
      note = held.note,
    )
  }

  suspend fun delete(id: String) {
    dao.deleteLines(id)
    dao.deleteCart(id)
  }

  private fun CartLine.toEntity(heldId: String) = HeldCartLineEntity(
    id = "$heldId:$id",
    heldCartId = heldId,
    lineNo = lineNo,
    variantId = variantId,
    description = description,
    sku = sku,
    quantity = quantity,
    unitPriceMinor = unitPrice.minor,
    catalogPriceMinor = catalogPrice.minor,
    unitCost = unitCost,
    taxRate = taxRate,
    taxCategoryId = taxCategoryId,
    barcodeScanned = barcodeScanned,
    adjustmentsJson = buildJsonArray {
      adjustments.forEach { adjustment ->
        add(buildJsonObject {
          put("kind", if (adjustment is LineAdjustment.Promotion) "promotion" else "manual")
          put("amount_minor", adjustment.amount.minor)
          put("reason", adjustment.reason)
        })
      }
    }.toString(),
    priceOverriddenBy = priceOverriddenBy,
    overrideReason = overrideReason,
    minimumAge = minimumAge,
    idScanRequired = idScanRequired,
    ageVerified = ageVerified,
  )

  private fun HeldCartLineEntity.toDomain(): CartLine = CartLine(
    id = id.substringAfter(':'),
    lineNo = lineNo,
    variantId = variantId,
    description = description,
    sku = sku,
    quantity = quantity,
    unitPrice = Money.ofMinor(unitPriceMinor),
    catalogPrice = Money.ofMinor(catalogPriceMinor),
    unitCost = unitCost,
    taxRate = taxRate,
    taxCategoryId = taxCategoryId,
    barcodeScanned = barcodeScanned,
    adjustments = json.parseToJsonElement(adjustmentsJson).jsonArray.map { encoded ->
      val item = encoded.jsonObject
      val amount = Money.ofMinor(item.getValue("amount_minor").jsonPrimitive.content.toLong())
      val reason = item.getValue("reason").jsonPrimitive.content
      if (item.getValue("kind").jsonPrimitive.content == "promotion") {
        LineAdjustment.Promotion(amount, reason)
      } else {
        LineAdjustment.ManualDiscount(amount, reason)
      }
    },
    priceOverriddenBy = priceOverriddenBy,
    overrideReason = overrideReason,
    minimumAge = minimumAge,
    idScanRequired = idScanRequired,
    ageVerified = ageVerified,
  )
}

package com.snappos.domain

/**
 * The cart.
 *
 * Pure Kotlin with no Android and no I/O, so the arithmetic that decides what a
 * customer is charged can be tested in milliseconds and proven against the same
 * cases as the TypeScript engine.
 *
 * Immutable. Every operation returns a new cart rather than mutating one, which
 * makes the whole history of a transaction a list of states — useful when a
 * cashier hits undo, and essential when two coroutines touch the cart at once
 * during a fast scan sequence.
 *
 * The invariant the totals maintain, and the one the server re-checks on
 * upload:
 *
 *     line.total   = (unit price × quantity) − discount + tax
 *     cart.total   = Σ line.total + tip
 *
 * If those two disagree the customer was charged something the reports will not
 * recognise, so `SalesService.computeVariance` on the server recomputes exactly
 * this and records any difference.
 */

/** A tax rate as it applied at the moment of sale, kept for the receipt and reports. */
data class TaxComponent(
  val name: String,
  /** Decimal string, never a float. 0.0825 has no exact binary form. */
  val rate: String,
  val amount: Money,
)

/**
 * Why a line costs less than its shelf price.
 *
 * **`amount` is a positive reduction**, never a negative addition. A discount of
 * five dollars is `5.00`, not `-5.00`.
 *
 * The convention is stated and enforced because mixing the two is a silent
 * class of bug: a sign error does not crash, it charges the customer more, and
 * the totals still add up internally. The server agrees - `discount_minor` in
 * the contracts package is non negative - so a value that is wrong here is
 * rejected at upload rather than quietly stored.
 */
sealed interface LineAdjustment {
  val amount: Money
  val reason: String

  data class ManualDiscount(override val amount: Money, override val reason: String) :
    LineAdjustment {
    init { require(!amount.isNegative) { "a discount is a positive reduction, got $amount" } }
  }

  data class Promotion(override val amount: Money, val promotionId: String) : LineAdjustment {
    override val reason: String get() = promotionId
    init { require(!amount.isNegative) { "a promotion is a positive reduction, got $amount" } }
  }
}

/**
 * A line in the cart.
 *
 * `catalogPrice` is what the shelf says and `unitPrice` is what is being
 * charged. They differ only when a manager has overridden the price, and
 * keeping both is what makes a price override visible in reporting rather than
 * indistinguishable from a cheaper product.
 */
data class CartLine(
  val id: String,
  val lineNo: Int,
  val variantId: String,
  val description: String,
  val sku: String,
  val quantity: Int,
  val unitPrice: Money,
  val catalogPrice: Money,
  val unitCost: String = "0",
  val taxRate: String = "0",
  val taxCategoryId: String? = null,
  val barcodeScanned: String? = null,
  val adjustments: List<LineAdjustment> = emptyList(),
  val priceOverriddenBy: String? = null,
  val overrideReason: String? = null,
  val minimumAge: Int? = null,
  val idScanRequired: Boolean = false,
  val ageVerified: Boolean = false,
) {
  init {
    require(quantity != 0) { "a line of zero quantity is not a line" }
    require(!unitPrice.isNegative) { "a negative unit price is a refund, not a sale line" }
  }

  val isPriceOverridden: Boolean get() = priceOverriddenBy != null

  /** Quantity times price, before any discount or tax. */
  val gross: Money get() = unitPrice * quantity

  val discount: Money get() = Money.sum(adjustments.map { it.amount })

  /**
   * What tax is charged on: gross less discount.
   *
   * Tax after the discount, never before. Charging tax on the pre-discount
   * amount overcharges the customer on every discounted line, which is both
   * wrong and, for a sales tax, the kind of wrong an auditor notices.
   */
  val taxable: Money get() = gross - discount

  val tax: Money get() = taxable.applyRate(taxRate)

  /** What this line contributes to the total. */
  val total: Money get() = taxable + tax

  /**
   * How far from the shelf price this line was sold.
   *
   * Non zero means an override happened. Summed across a shift it is one of the
   * more revealing loss prevention numbers there is.
   */
  val priceVariance: Money get() = (unitPrice - catalogPrice) * quantity

  val requiresAgeCheck: Boolean get() = minimumAge != null && !ageVerified

  fun taxBreakdown(): List<TaxComponent> =
    if (taxRate == "0") emptyList()
    else listOf(TaxComponent(name = "Sales Tax", rate = taxRate, amount = tax))
}

/**
 * A cart level discount, spread across lines.
 *
 * Spreading matters: if "$5 off the order" stayed at cart level, the line
 * amounts would no longer sum to the cart total, and every downstream
 * consumer — the receipt, the tax report, a partial refund — would have to
 * reinvent the split, differently each time.
 */
data class CartDiscount(val amount: Money, val reason: String) {
  init { require(!amount.isNegative) { "a cart discount is a positive reduction, got $amount" } }
}

data class Cart(
  val lines: List<CartLine> = emptyList(),
  val cartDiscount: CartDiscount? = null,
  val tip: Money = Money.ZERO,
  val customerId: String? = null,
  val taxExempt: Boolean = false,
  val taxExemptReason: String? = null,
  val note: String? = null,
) {
  val isEmpty: Boolean get() = lines.isEmpty()
  val itemCount: Int get() = lines.sumOf { it.quantity }

  /**
   * Lines with the cart discount already spread across them.
   *
   * Everything below derives from this, so the split happens exactly once and
   * nothing downstream can disagree about it.
   */
  val effectiveLines: List<CartLine>
    get() {
      val discount = cartDiscount ?: return applyExemption(lines)
      if (lines.isEmpty()) return emptyList()

      // Proportional to what each line is worth, remainder to the largest.
      // allocateByWeight guarantees the parts sum back to the whole, so no cent
      // is created or lost by the split.
      val weights = lines.map { it.taxable }
      val shares = discount.amount.allocateByWeight(weights)

      return applyExemption(
        lines.mapIndexed { index, line ->
          val share = shares[index]
          if (share.isZero) line
          else line.copy(
            adjustments = line.adjustments +
              LineAdjustment.ManualDiscount(share, discount.reason),
          )
        },
      )
    }

  private fun applyExemption(source: List<CartLine>): List<CartLine> =
    if (!taxExempt) source else source.map { it.copy(taxRate = "0") }

  val subtotal: Money get() = Money.sum(effectiveLines.map { it.gross })
  val discountTotal: Money get() = Money.sum(effectiveLines.map { it.discount })
  val taxTotal: Money get() = Money.sum(effectiveLines.map { it.tax })
  val total: Money get() = Money.sum(effectiveLines.map { it.total }) + tip

  /** Lines still needing an ID check. The register blocks payment while this is non empty. */
  val unverifiedAgeRestrictedLines: List<CartLine>
    get() = effectiveLines.filter { it.requiresAgeCheck }

  val requiresAgeVerification: Boolean get() = unverifiedAgeRestrictedLines.isNotEmpty()

  /** The highest age any line requires, which is what the cashier is prompted for. */
  val minimumAgeRequired: Int? get() = lines.mapNotNull { it.minimumAge }.maxOrNull()

  // ----------------------------------------------------------------- mutation

  /**
   * Add a scanned item.
   *
   * Scanning the same thing twice increments the existing line rather than
   * adding a second one. A cashier ringing six identical drinks should see
   * "6 × 3.99", not six rows to scroll past — and the merge is only correct
   * when price, override state and tax all match, otherwise two genuinely
   * different lines would be silently combined.
   */
  fun addItem(
    id: String,
    variantId: String,
    description: String,
    sku: String,
    unitPrice: Money,
    catalogPrice: Money = unitPrice,
    quantity: Int = 1,
    unitCost: String = "0",
    taxRate: String = "0",
    barcodeScanned: String? = null,
    minimumAge: Int? = null,
    idScanRequired: Boolean = false,
  ): Cart {
    val mergeable = lines.indexOfFirst {
      it.variantId == variantId &&
        it.unitPrice == unitPrice &&
        !it.isPriceOverridden &&
        it.taxRate == taxRate &&
        it.adjustments.isEmpty()
    }

    if (mergeable >= 0) {
      val existing = lines[mergeable]
      return copy(
        lines = lines.toMutableList().apply {
          this[mergeable] = existing.copy(quantity = existing.quantity + quantity)
        },
      )
    }

    return copy(
      lines = lines + CartLine(
        id = id,
        lineNo = (lines.maxOfOrNull { it.lineNo } ?: 0) + 1,
        variantId = variantId,
        description = description,
        sku = sku,
        quantity = quantity,
        unitPrice = unitPrice,
        catalogPrice = catalogPrice,
        unitCost = unitCost,
        taxRate = taxRate,
        barcodeScanned = barcodeScanned,
        minimumAge = minimumAge,
        idScanRequired = idScanRequired,
      ),
    )
  }

  fun setQuantity(lineId: String, quantity: Int): Cart =
    if (quantity <= 0) removeLine(lineId)
    else copy(lines = lines.map { if (it.id == lineId) it.copy(quantity = quantity) else it })

  /** Removing renumbers, so line numbers stay 1..n and a receipt reads sensibly. */
  fun removeLine(lineId: String): Cart =
    copy(
      lines = lines.filterNot { it.id == lineId }
        .mapIndexed { index, line -> line.copy(lineNo = index + 1) },
    )

  fun discountLine(lineId: String, amount: Money, reason: String): Cart {
    require(!amount.isZero && !amount.isNegative) { "discount must be greater than zero" }
    return copy(
      lines = lines.map {
        if (it.id != lineId) it
        else {
          require(it.discount + amount <= it.gross) { "discount cannot exceed the line amount" }
          it.copy(adjustments = it.adjustments + LineAdjustment.ManualDiscount(amount, reason))
        }
      },
    )
  }

  /**
   * Override a price. Requires the manager who authorized it.
   *
   * The authorizer is a parameter rather than something read from session state
   * so that it cannot be omitted: an override with no name attached is
   * indistinguishable from a mispriced product after the fact.
   */
  fun overridePrice(lineId: String, newPrice: Money, authorizedBy: String, reason: String): Cart =
    copy(
      lines = lines.map {
        if (it.id != lineId) it
        else it.copy(
          unitPrice = newPrice,
          priceOverriddenBy = authorizedBy,
          overrideReason = reason,
        )
      },
    )

  fun markAgeVerified(): Cart = copy(lines = lines.map { it.copy(ageVerified = true) })

  fun applyCartDiscount(amount: Money, reason: String): Cart =
    copy(cartDiscount = CartDiscount(amount, reason))

  fun clearCartDiscount(): Cart = copy(cartDiscount = null)

  fun withTip(amount: Money): Cart = copy(tip = amount)

  fun withCustomer(id: String?): Cart = copy(customerId = id)

  fun exemptTax(reason: String): Cart = copy(taxExempt = true, taxExemptReason = reason)

  companion object {
    val EMPTY = Cart()
  }
}

package com.snappos.data.entities

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/** An unpaid basket deliberately parked on this register. */
@Entity(
  tableName = "held_carts",
  indices = [Index("updatedAtMillis"), Index("cashierUserId")],
)
data class HeldCartEntity(
  @PrimaryKey val id: String,
  val label: String,
  val cashierUserId: String,
  val customerId: String?,
  val taxExempt: Boolean,
  val taxExemptReason: String?,
  val note: String?,
  val cartDiscountMinor: Long?,
  val cartDiscountReason: String?,
  val tipMinor: Long,
  val createdAtMillis: Long,
  val updatedAtMillis: Long,
)

/** Full line snapshot: a held basket must resume at exactly the amount shown when parked. */
@Entity(
  tableName = "held_cart_lines",
  indices = [Index("heldCartId"), Index("variantId")],
)
data class HeldCartLineEntity(
  @PrimaryKey val id: String,
  val heldCartId: String,
  val lineNo: Int,
  val variantId: String,
  val description: String,
  val sku: String,
  val quantity: Int,
  val unitPriceMinor: Long,
  val catalogPriceMinor: Long,
  val unitCost: String,
  val taxRate: String,
  val taxCategoryId: String?,
  val barcodeScanned: String?,
  val adjustmentsJson: String,
  val priceOverriddenBy: String?,
  val overrideReason: String?,
  val minimumAge: Int?,
  val idScanRequired: Boolean,
  val ageVerified: Boolean,
)

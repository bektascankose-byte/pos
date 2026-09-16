package com.snappos.data.entities

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * The register's local database.
 *
 * Two kinds of table live here and the difference decides everything about how
 * each is treated:
 *
 *   **Projections** — catalog, barcodes, prices, inventory, employees. The
 *   server is the authority. On conflict the server wins and the local copy is
 *   overwritten. Losing one of these costs a re-sync and nothing else.
 *
 *   **Local truth** — completed sales, cash movements, the outbox. The register
 *   is the authority until the server acknowledges them. These have never been
 *   anywhere else, and losing one loses a sale that actually happened.
 *
 * Everything is encrypted with SQLCipher under a key held in the Android
 * Keystore. A terminal behind a counter is a device that gets stolen, and this
 * file holds the whole catalog, employee PIN hashes and a day of takings.
 *
 * Money is stored as `Long` minor units and quantities as `String` decimals,
 * matching the server exactly. No `Double` appears anywhere in this file.
 */

/** A sellable variant. Everything sellable is a variant, including single ones. */
@Entity(
  tableName = "variants",
  indices = [Index("productId"), Index("sku"), Index("categoryId")],
)
data class VariantEntity(
  @PrimaryKey val id: String,
  val productId: String,
  val productName: String,
  val variantName: String?,
  val sku: String,
  val plu: String?,
  val brandId: String?,
  val brandName: String?,
  val categoryId: String?,
  val taxCategoryId: String?,
  /** numeric(14,6) on the server. Kept as text so it never becomes a float. */
  val cost: String,
  val caseQuantity: Int,
  /**
   * Path to this item's photo on the server, relative to the configured base
   * URL, or null. A path rather than an id because the server owns the shape of
   * its own routes; the register only has to join it to the host it syncs with.
   */
  val imageUrl: String?,
  val sortOrder: Int,
  val isDefault: Boolean,
  val status: String,
  /**
   * Compliance, denormalized onto the variant on purpose.
   *
   * It lives on the product server side, but the register needs the age rule in
   * the same row it resolves a barcode to. The prompt has to be decidable
   * before the line renders, and a second lookup inside the 120ms scan budget
   * is a cost with no benefit.
   */
  val minimumAge: Int?,
  val idScanRequired: Boolean,
  val regulatedClass: String?,
  /** Denormalized for the same reason: search must not join. */
  val searchText: String,
  val updatedAt: Long,
)

/**
 * A barcode.
 *
 * `units` is how many sellable units one scan represents, so scanning a case of
 * ten adds ten. That belongs on the barcode rather than the variant because the
 * same variant can have both a unit and a case barcode.
 */
@Entity(tableName = "barcodes", indices = [Index("variantId")])
data class BarcodeEntity(
  @PrimaryKey val barcode: String,
  val variantId: String,
  val kind: String,
  val units: String,
  val isPrimary: Boolean,
)

/**
 * A price for this store.
 *
 * Effective dated, because a price change scheduled for Monday must already be
 * on the register on Sunday night, and a register that is offline on Monday
 * still has to charge the new price.
 */
@Entity(
  tableName = "prices",
  indices = [Index("variantId"), Index(value = ["variantId", "kind", "effectiveFrom"])],
)
data class PriceEntity(
  @PrimaryKey val id: String,
  val variantId: String,
  val kind: String,
  val priceMinor: Long,
  val effectiveFrom: Long,
  val effectiveTo: Long?,
)

@Entity(tableName = "categories", indices = [Index("parentId"), Index("path")])
data class CategoryEntity(
  @PrimaryKey val id: String,
  val parentId: String?,
  val name: String,
  val path: String,
  val depth: Int,
  val sortOrder: Int,
  val tileColor: String?,
  val isDepartment: Boolean,
)

/**
 * Stock, as of the last sync.
 *
 * Advisory, never authoritative. The register shows it so a cashier can answer
 * "do we have more of these", but it does **not** gate a sale: the customer is
 * standing there holding the product, and refusing to sell something that is
 * physically in their hand because a projection says zero would be absurd.
 * Overselling is reconciled server side and raises an alert.
 */
@Entity(tableName = "inventory", indices = [Index("variantId")])
data class InventoryEntity(
  @PrimaryKey val variantId: String,
  val onHand: String,
  val available: String,
  val updatedAt: Long,
)

/**
 * An employee who may unlock this register.
 *
 * The PIN hash is replicated so unlock works with no network. It is an Argon2id
 * hash with the same parameters the server uses, verified on device. The
 * password hash is deliberately **not** replicated: a password unlocks the
 * dashboard and everything in it, and a stolen terminal must not carry one.
 */
@Entity(tableName = "employees", indices = [Index("employeeCode")])
data class EmployeeEntity(
  @PrimaryKey val id: String,
  val displayName: String,
  val employeeCode: String?,
  val pinHash: String,
  val permissions: String,
  val status: String,
  val failedPinAttempts: Int = 0,
  val lockedUntilMillis: Long? = null,
)

/**
 * A sale composed on this device.
 *
 * Written in one local transaction the instant the cashier takes payment, then
 * queued. `syncState` is the only mutable column: the sale itself is a
 * historical fact and is never edited, matching the server's append only rule.
 */
@Entity(
  tableName = "sales",
  indices = [Index("syncState"), Index("completedAtMillis"), Index("receiptNo")],
)
data class SaleEntity(
  /** UUIDv7, generated on this device before any network existed. */
  @PrimaryKey val id: String,
  val storeId: String,
  val registerId: String,
  val sessionId: String?,
  val cashierUserId: String,
  val customerId: String?,
  /** `{store}-{register}-{sequence}`, printable with no number server. */
  val receiptNo: String,
  val registerSequence: Long,
  val status: String,
  val subtotalMinor: Long,
  val discountMinor: Long,
  val taxMinor: Long,
  val tipMinor: Long,
  val totalMinor: Long,
  val taxExempt: Boolean,
  val taxExemptReason: String?,
  val note: String?,
  val deviceTimeMillis: Long,
  val completedAtMillis: Long?,
  /**
   * Who voided this sale, and why.
   *
   * Nullable because almost no sale is voided, but recorded the moment one is:
   * a void reverses money and stock at once, and a void with nobody's name on
   * it is indistinguishable after the fact from a cashier erasing their own
   * mistake — or their own theft.
   */
  val voidedAtMillis: Long? = null,
  val voidedBy: String? = null,
  val voidReason: String? = null,
  /** pending, uploading, acknowledged, failed */
  val syncState: String,
)

@Entity(tableName = "sale_lines", indices = [Index("saleId"), Index("variantId")])
data class SaleLineEntity(
  @PrimaryKey val id: String,
  val saleId: String,
  val lineNo: Int,
  val variantId: String,
  val description: String,
  val skuSnapshot: String,
  val barcodeScanned: String?,
  val quantity: String,
  val unitPriceMinor: Long,
  val originalPriceMinor: Long,
  val priceOverridden: Boolean,
  val overrideBy: String?,
  val overrideReason: String?,
  val discountMinor: Long,
  val taxMinor: Long,
  val totalMinor: Long,
  val unitCost: String,
  /** JSON. Rebuilt into the server's tax_snapshot on upload. */
  val taxSnapshotJson: String,
  val complianceSnapshotJson: String,
  /**
   * How much of this line has been refunded.
   *
   * The one mutable column on a sale, mirroring the server exactly, and it
   * exists for one job: making it impossible to refund four of something that
   * was sold in a quantity of three.
   *
   * The register's copy is advisory — another register can refund the same
   * receipt while this one is offline, and only the server knows that. It is
   * still worth keeping, because catching an over-refund at the counter is
   * infinitely better than catching it on upload, when the customer has already
   * been handed the money.
   */
  val quantityRefunded: String = "0",
)

@Entity(tableName = "payments", indices = [Index("saleId")])
data class PaymentEntity(
  @PrimaryKey val id: String,
  val saleId: String,
  val method: String,
  val status: String,
  val amountMinor: Long,
  val tenderedMinor: Long?,
  val changeMinor: Long,
  val tipMinor: Long,
  val provider: String?,
  val providerPaymentId: String?,
  /**
   * A token from the terminal. Never a card number.
   *
   * There is no column anywhere in this file that could hold a PAN, and
   * `cardLast4` is validated to four digits. That is deliberate: a device that
   * gets stolen must not be able to carry card data, and the only reliable way
   * to guarantee that is to have nowhere to put it.
   */
  val providerToken: String?,
  val cardLast4: String?,
  val cardBrand: String?,
  val authCode: String?,
  val deviceTimeMillis: Long,
)

/** An age check. Metadata only: no name, no date of birth, no licence number. */
@Entity(tableName = "age_verifications", indices = [Index("saleId")])
data class AgeVerificationEntity(
  @PrimaryKey val id: String,
  val saleId: String?,
  val saleLineId: String?,
  val method: String,
  val result: String,
  val minimumAgeApplied: Int,
  val verifiedAtMillis: Long,
)

/**
 * The upload queue.
 *
 * A row here is a completed fact waiting for the network. It is written in the
 * same local transaction as the thing it describes, which is what makes "the
 * sale committed but was never queued" impossible rather than unlikely.
 *
 * `entityId` is the entity's own UUIDv7 and doubles as its idempotency key, so
 * there is no separate key to get wrong and no way to submit one entity twice
 * under two identities.
 */
@Entity(
  tableName = "sync_outbox",
  indices = [Index("state"), Index("createdAtMillis"), Index(value = ["entityType", "entityId"], unique = true)],
)
data class OutboxEntity(
  @PrimaryKey val id: String,
  val entityType: String,
  val entityId: String,
  val payloadJson: String,
  val deviceTimeMillis: Long,
  val createdAtMillis: Long,
  /** pending, uploading, acknowledged, dead */
  val state: String,
  val attempts: Int,
  val lastAttemptMillis: Long?,
  val lastError: String?,
  /** Exponential backoff. Not retried before this. */
  val nextAttemptMillis: Long,
)

/** What this device is: which store, which register, and how it reaches the server. */
@Entity(tableName = "register_config")
data class RegisterConfigEntity(
  @PrimaryKey val id: Int = 1,
  val orgId: String,
  val storeId: String,
  val storeCode: String,
  val storeName: String,
  val registerId: String,
  val registerCode: String,
  val deviceId: String,
  val apiBaseUrl: String,
  /** Next receipt sequence. Incremented locally; never needs the network. */
  val nextSequence: Long,
  val taxRate: String,
  val lastCatalogCursor: String,
  val clockOffsetMillis: Long,
  /**
   * Who a sale is attributed to.
   *
   * Set from the signed-in session. Replaced by whoever unlocked the register
   * once PIN unlock exists; until then a sale must still name a real user, or
   * the server rejects the upload on a foreign key and the sale sits in the
   * dead letter list for a reason nobody can act on.
   */
  val cashierUserId: String? = null,
)

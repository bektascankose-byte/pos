package com.snappos.pos.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.snappos.data.CatalogRepository
import com.snappos.data.Cashier
import com.snappos.data.CashRepository
import com.snappos.data.DevProvisioning
import com.snappos.data.CommittedSale
import com.snappos.data.RefundRepository
import com.snappos.data.dao.ConfigDao
import com.snappos.domain.ReceiptItem
import com.snappos.domain.ReceiptStore
import com.snappos.domain.ReceiptTender
import com.snappos.domain.SaleReceipt
import java.time.Instant
import com.snappos.data.RosterDiagnosis
import com.snappos.data.VoidRepository
import com.snappos.data.RefundSelection
import com.snappos.data.RefundableSale
import com.snappos.data.ShiftRepository
import com.snappos.data.UnlockResult
import com.snappos.data.entities.EmployeeEntity
import com.snappos.data.ResolvedProduct
import com.snappos.data.SaleRepository
import com.snappos.data.Tender
import com.snappos.domain.Cart
import com.snappos.domain.Money
import com.snappos.domain.Uuid7
import com.snappos.sync.CatalogSync
import com.snappos.sync.DevSignIn
import com.snappos.sync.SyncWorker
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import android.content.Context
import javax.inject.Inject

/** A short lived message for the cashier. Not an error dialog; a line of text. */
data class Toast(val text: String, val isError: Boolean = false)

/** What the register is showing: the shift gate, the drawer gate, or the till. */
enum class RegisterStage { Locked, DrawerClosed, Selling, Refunding }

/**
 * What the manager standing at the register is being asked to authorise.
 *
 * One dialog serves both, but they must never be confused: approving a
 * partial refund and approving the reversal of a whole sale are different
 * amounts of money and different permissions.
 */
enum class ApprovalKind { Refund, VoidSale }

data class RegisterUiState(
  val stage: RegisterStage = RegisterStage.Locked,
  val employees: List<EmployeeEntity> = emptyList(),
  /** Why the roster is empty, when it is. Never shown while staff exist. */
  val rosterDiagnosis: RosterDiagnosis? = null,
  val cashier: Cashier? = null,
  val sessionId: String? = null,
  val cart: Cart = Cart.EMPTY,
  val tiles: List<ResolvedProduct> = emptyList(),
  val categories: List<CategoryTile> = emptyList(),
  val selectedCategoryId: String? = null,
  val searchQuery: String = "",
  val message: Toast? = null,
  val lastReceiptNo: String? = null,
  val lastChange: Money? = null,
  /**
   * The receipt for the sale just rung, kept so it can be shown or printed.
   *
   * Built at the moment of sale rather than reconstructed later: the receipt
   * is what the customer was handed, and rebuilding it from the database
   * would let a change in this code alter a receipt that already exists on
   * paper.
   */
  val lastReceipt: SaleReceipt? = null,
  val showingReceipt: Boolean = false,
  val busy: Boolean = false,
  // ------------------------------------------------------------------ refunds
  val refundSale: RefundableSale? = null,
  val refundSelections: Map<String, Int> = emptyMap(),
  val refundRestock: Map<String, Boolean> = emptyMap(),
  val refundReason: String = "customer_changed_mind",
  val refundError: String? = null,
  val approvalPrompt: String? = null,
  val approvalKind: ApprovalKind? = null,
  val approvalError: String? = null,
)

data class CategoryTile(val id: String, val name: String)

@HiltViewModel
class RegisterViewModel @Inject constructor(
  @ApplicationContext private val context: Context,
  private val catalog: CatalogRepository,
  private val sales: SaleRepository,
  private val provisioning: DevProvisioning,
  private val devSignIn: DevSignIn,
  private val catalogSync: CatalogSync,
  private val shift: ShiftRepository,
  private val drawer: CashRepository,
  private val refunds: RefundRepository,
  private val voids: VoidRepository,
  private val config: ConfigDao,
) : ViewModel() {

  private val _state = MutableStateFlow(RegisterUiState())
  val state: StateFlow<RegisterUiState> = _state.asStateFlow()

  /**
   * What the header pill shows.
   *
   * Derived from the outbox rather than from a network probe. "Can I reach the
   * server" is the wrong question at a counter; "is anything waiting to be
   * handed over" is the one a cashier and a manager actually care about.
   */
  val pendingUploads: StateFlow<Int> =
    sales.pendingUploads.stateIn(viewModelScope, SharingStarted.Eagerly, 0)

  val deadLetters: StateFlow<Int> =
    sales.deadLetters.stateIn(viewModelScope, SharingStarted.Eagerly, 0)

  private var taxRate: String = "0"

  init {
    viewModelScope.launch {
      // Provisioning says how to reach the server. The catalog comes only from
      // the server: a local seed alongside a pulled catalog gave every product
      // two rows with different ids, which is why DevSeed was deleted.
      provisioning.ensureProvisioned()
      taxRate = catalog.taxRate()
      loadTiles(null)

      if (catalog.isEmpty()) {
        _state.value = _state.value.copy(
          message = Toast("No catalog yet. Connecting to the server...", isError = false),
        )
      }

      if (devSignIn.ensureSignedIn()) {
        devSignIn.adoptServerIdentity()
        val pulled = catalogSync.pull()
        if (pulled.ok) {
          taxRate = catalog.taxRate()
          loadTiles(_state.value.selectedCategoryId)
          _state.value = _state.value.copy(message = null)
        } else if (catalog.isEmpty()) {
          _state.value = _state.value.copy(
            message = Toast("No catalog on this register. ${pulled.failure}", isError = true),
          )
        }
        // Hand over anything left from a previous offline stretch.
        SyncWorker.syncNow(context)
      }
    }
    // Its own coroutine: collect() on a Room Flow never returns, so anything
    // sequenced after it in the same launch block would never run.
    viewModelScope.launch {
      catalog.categories().collect { rows ->
        _state.value = _state.value.copy(
          categories = rows.filter { it.depth == 0 }.map { CategoryTile(it.id, it.name) },
        )
      }
    }
    viewModelScope.launch {
      shift.activeEmployees().collect { rows ->
        _state.value = _state.value.copy(employees = rows)
      }
    }
    viewModelScope.launch {
      shift.rosterDiagnosis().collect { diagnosis ->
        _state.value = _state.value.copy(rosterDiagnosis = diagnosis)
      }
    }
  }

  private suspend fun loadTiles(categoryId: String?) {
    // Resolved before the state is touched. See onSearch for why.
    val rows = catalog.byCategory(categoryId, limit = 60)
    _state.value = _state.value.copy(tiles = rows)
  }

  fun selectCategory(categoryId: String?) {
    viewModelScope.launch {
      _state.value = _state.value.copy(selectedCategoryId = categoryId, searchQuery = "")
      loadTiles(categoryId)
    }
  }

  /**
   * A scan.
   *
   * The single most performance sensitive path in the product. Everything here
   * is local: one indexed lookup, then a pure function over the cart. No
   * network call, no suspension beyond the database read, and no animation on
   * the resulting row — a row that animates in is a row the cashier waits for.
   */
  fun onScan(barcode: String) {
    if (barcode.isBlank()) return
    viewModelScope.launch {
      val product = catalog.scan(barcode)
      if (product == null) {
        _state.value = _state.value.copy(
          message = Toast("No product for $barcode", isError = true),
        )
        return@launch
      }
      addToCart(product, scanned = barcode)
    }
  }

  fun onSearch(query: String) {
    viewModelScope.launch {
      _state.value = _state.value.copy(searchQuery = query)

      // The query is resolved into a local **before** the state is read.
      //
      // `_state.value = _state.value.copy(tiles = <suspending call>)` looks
      // atomic and is not: Kotlin evaluates the receiver first, then suspends
      // on the database read, then copies the state it captured before the
      // suspension. Anything written while it was suspended is silently
      // discarded.
      //
      // That lost scans. Clearing the scan field calls this on every submit, so
      // two scans in quick succession overlapped: the search started by the
      // first read the cart, suspended, and wrote back the pre-scan cart over
      // the item the second had just added. Measured at 30% loss on a phone
      // scanning as fast as adb can drive it, and 0% with a pause between
      // scans - which is exactly the shape of a bug nobody reproduces at a desk
      // and everybody hits at a counter during a rush.
      val rows = if (query.isBlank()) catalog.byCategory(_state.value.selectedCategoryId, 60)
      else catalog.search(query, 60)
      _state.value = _state.value.copy(tiles = rows)
    }
  }

  fun addToCart(product: ResolvedProduct, scanned: String? = null) {
    val price = product.price
    if (price == null) {
      // Selling at a price nobody set is how a shop loses money quietly, so the
      // register refuses rather than guessing at zero.
      _state.value = _state.value.copy(
        message = Toast("${product.sku} has no price. Ask a manager.", isError = true),
      )
      return
    }

    _state.value = _state.value.copy(
      cart = _state.value.cart.addItem(
        id = Uuid7.generate(),
        variantId = product.variantId,
        description = product.displayName,
        sku = product.sku,
        unitPrice = price,
        quantity = product.units,
        unitCost = product.cost,
        taxRate = taxRate,
        barcodeScanned = scanned,
        minimumAge = product.minimumAge,
        idScanRequired = product.idScanRequired,
      ),
      message = null,
    )
  }

  fun setQuantity(lineId: String, quantity: Int) {
    _state.value = _state.value.copy(cart = _state.value.cart.setQuantity(lineId, quantity))
  }

  fun removeLine(lineId: String) {
    _state.value = _state.value.copy(cart = _state.value.cart.removeLine(lineId))
  }

  fun clearCart() {
    _state.value = _state.value.copy(cart = Cart.EMPTY, message = null)
  }

  fun confirmAgeVerified() {
    _state.value = _state.value.copy(cart = _state.value.cart.markAgeVerified())
  }

  /**
   * Start a shift.
   *
   * Verified on device against the replicated Argon2id hash. The register is
   * most likely to be offline exactly when a shift starts, so an unlock that
   * needs a round trip is an unlock that fails when it matters.
   */
  fun unlock(userId: String, pin: String) {
    viewModelScope.launch {
      _state.value = _state.value.copy(busy = true, message = null)
      when (val result = shift.unlock(userId, pin)) {
        is UnlockResult.Success -> {
          val openSession = drawer.openSessionId()
          _state.value = _state.value.copy(
            busy = false,
            cashier = result.cashier,
            sessionId = openSession,
            // A drawer has to be open before cash can be taken, so a register
            // with no session goes to the drawer gate rather than to a till
            // that would fail at the moment of payment.
            stage = if (openSession == null) RegisterStage.DrawerClosed else RegisterStage.Selling,
            message = null,
          )
        }
        is UnlockResult.WrongPin ->
          _state.value = _state.value.copy(busy = false, message = Toast("Wrong PIN", true))
        is UnlockResult.LockedOut ->
          _state.value = _state.value.copy(
            busy = false,
            message = Toast("Locked for 15 minutes after 5 wrong PINs", true),
          )
        is UnlockResult.NoEmployees ->
          _state.value = _state.value.copy(
            busy = false,
            message = Toast("That employee is not on this register", true),
          )
      }
    }
  }

  /** End the shift. The cart is deliberately kept: locking is not cancelling. */
  fun lock() {
    _state.value = _state.value.copy(stage = RegisterStage.Locked, cashier = null, message = null)
  }

  fun openDrawer(openingFloat: Money) {
    val cashier = _state.value.cashier ?: return
    viewModelScope.launch {
      _state.value = _state.value.copy(busy = true)
      drawer.open(cashier.userId, openingFloat)
        .onSuccess { sessionId ->
          _state.value = _state.value.copy(
            busy = false,
            sessionId = sessionId,
            stage = RegisterStage.Selling,
            message = Toast("Drawer open with ${openingFloat.toMajorString()}"),
          )
          SyncWorker.syncNow(context)
        }
        .onFailure {
          _state.value = _state.value.copy(
            busy = false,
            message = Toast(it.message ?: "Could not open the drawer", true),
          )
        }
    }
  }

  /**
   * Close the drawer against a counted amount.
   *
   * Closing needs `cash.session_close`, which a cashier does not have by
   * default: closing produces the over/short number a shift is judged by, and
   * letting the person who is short report their own variance removes the only
   * check on it.
   */
  fun closeDrawer(counted: Money) {
    val cashier = _state.value.cashier ?: return
    val sessionId = _state.value.sessionId ?: return

    if (!cashier.can("cash.session_close")) {
      _state.value = _state.value.copy(
        message = Toast("A manager has to close the drawer", true),
      )
      return
    }

    viewModelScope.launch {
      _state.value = _state.value.copy(busy = true)
      drawer.close(sessionId, cashier.userId, counted)
        .onSuccess { result ->
          _state.value = _state.value.copy(
            busy = false,
            sessionId = null,
            stage = RegisterStage.DrawerClosed,
            message = Toast(
              "Drawer ${result.outcome}: counted ${result.counted.toMajorString()}, " +
                "expected ${result.expected.toMajorString()}",
              isError = result.outcome == "short",
            ),
          )
          SyncWorker.syncNow(context)
        }
        .onFailure {
          _state.value = _state.value.copy(
            busy = false,
            message = Toast(it.message ?: "Could not close the drawer", true),
          )
        }
    }
  }

  // ----------------------------------------------------------------- refunds

  fun startRefund() {
    _state.value = _state.value.copy(
      stage = RegisterStage.Refunding,
      refundSale = null,
      refundSelections = emptyMap(),
      refundRestock = emptyMap(),
      refundError = null,
      message = null,
    )
  }

  fun cancelRefund() {
    _state.value = _state.value.copy(
      stage = RegisterStage.Selling,
      refundSale = null,
      refundSelections = emptyMap(),
      refundRestock = emptyMap(),
      refundError = null,
      approvalPrompt = null,
    )
  }

  /**
   * Find the sale a customer is returning against.
   *
   * Local only. A sale rung on another register is not on this device, and the
   * honest answer is to say so rather than invent a refund with nothing to
   * check a quantity against.
   */
  fun lookupReceipt(receiptNo: String) {
    viewModelScope.launch {
      _state.value = _state.value.copy(busy = true, refundError = null)
      val found = refunds.findByReceipt(receiptNo)

      // Every suspending call resolved before the state is read. Suspending
      // inside a `_state.value.copy(...)` argument captures the state first and
      // writes it back after, discarding whatever happened in between — the
      // lost update that was dropping scans.
      val voided = if (found == null) refunds.wasVoided(receiptNo) else false

      _state.value = when {
        found == null -> _state.value.copy(
          busy = false,
          refundError = if (voided) {
            "$receiptNo was voided. There is nothing left to refund on it."
          } else {
            "No sale on this register with receipt $receiptNo"
          },
        )
        found.fullyRefunded -> _state.value.copy(
          busy = false,
          refundError = "Everything on $receiptNo has already been refunded",
        )
        else -> _state.value.copy(
          busy = false,
          refundSale = found,
          refundRestock = found.lines.associate { it.saleLineId to true },
          refundError = null,
        )
      }
    }
  }

  fun setRefundQuantity(saleLineId: String, quantity: Int) {
    _state.value = _state.value.copy(
      refundSelections = _state.value.refundSelections + (saleLineId to quantity),
      refundError = null,
    )
  }

  fun toggleRefundRestock(saleLineId: String) {
    val current = _state.value.refundRestock[saleLineId] ?: true
    _state.value = _state.value.copy(
      refundRestock = _state.value.refundRestock + (saleLineId to !current),
    )
  }

  fun setRefundReason(code: String) {
    _state.value = _state.value.copy(refundReason = code)
  }

  /** Ask for a manager. A refund is never approved by the person taking it. */
  fun requestRefundApproval() {
    _state.value = _state.value.copy(
      approvalPrompt = "Approve this refund",
      approvalKind = ApprovalKind.Refund,
      approvalError = null,
    )
  }

  /** Ask for a manager before reversing a whole sale. */
  fun requestVoidApproval() {
    _state.value = _state.value.copy(
      approvalPrompt = "Void this entire sale",
      approvalKind = ApprovalKind.VoidSale,
      approvalError = null,
    )
  }

  fun dismissApproval() {
    _state.value = _state.value.copy(
      approvalPrompt = null,
      approvalKind = null,
      approvalError = null,
    )
  }

  /** One entry point; the pending action decides what the PIN authorises. */
  fun approve(pin: String) {
    when (_state.value.approvalKind) {
      ApprovalKind.Refund -> approveRefund(pin)
      ApprovalKind.VoidSale -> approveVoid(pin)
      null -> Unit
    }
  }

  /**
   * A manager PIN, checked against every employee holding `sale.void`.
   *
   * A different permission from a refund on purpose: a shop may well let a
   * shift lead reverse a mis-rung sale at the counter without letting them hand
   * cash back against a receipt from last week.
   */
  private fun approveVoid(pin: String) {
    val sale = _state.value.refundSale ?: return
    val cashier = _state.value.cashier ?: return

    viewModelScope.launch {
      _state.value = _state.value.copy(busy = true)
      val manager = shift.approve("sale.void", pin)
      if (manager == null) {
        _state.value = _state.value.copy(
          busy = false,
          approvalError = "That PIN cannot void a sale",
        )
        return@launch
      }

      voids.commit(
        sale = sale,
        cashierUserId = cashier.userId,
        approvedBy = manager.userId,
        reason = _state.value.refundReason,
        sessionId = _state.value.sessionId,
      ).onSuccess { voided ->
        _state.value = _state.value.copy(
          busy = false,
          stage = RegisterStage.Selling,
          refundSale = null,
          refundSelections = emptyMap(),
          refundRestock = emptyMap(),
          approvalPrompt = null,
          approvalKind = null,
          message = Toast(
            "Voided ${voided.receiptNo}: ${voided.total.toMajorString()} " +
              "approved by ${manager.displayName}",
          ),
        )
        SyncWorker.syncNow(context)
      }.onFailure {
        _state.value = _state.value.copy(
          busy = false,
          approvalPrompt = null,
          approvalKind = null,
          refundError = it.message ?: "Could not void that sale",
        )
      }
    }
  }

  /**
   * A manager PIN, checked against every employee holding `refund.create`.
   *
   * Verified on device like every other PIN, so a refund can be approved on a
   * register with no network - which is exactly when a customer is standing
   * there waiting.
   */
  private fun approveRefund(pin: String) {
    val sale = _state.value.refundSale ?: return
    val cashier = _state.value.cashier ?: return

    viewModelScope.launch {
      _state.value = _state.value.copy(busy = true)
      val manager = shift.approve("refund.create", pin)
      if (manager == null) {
        _state.value = _state.value.copy(
          busy = false,
          approvalError = "That PIN cannot approve a refund",
        )
        return@launch
      }

      val selections = _state.value.refundSelections
        .filterValues { it > 0 }
        .map { (lineId, quantity) ->
          RefundSelection(
            saleLineId = lineId,
            quantity = quantity,
            restock = _state.value.refundRestock[lineId] ?: true,
          )
        }

      refunds.commit(
        sale = sale,
        selections = selections,
        cashierUserId = cashier.userId,
        approvedBy = manager.userId,
        reasonCode = _state.value.refundReason,
        sessionId = _state.value.sessionId,
      ).onSuccess { committed ->
        _state.value = _state.value.copy(
          busy = false,
          stage = RegisterStage.Selling,
          refundSale = null,
          refundSelections = emptyMap(),
          refundRestock = emptyMap(),
          approvalPrompt = null,
          approvalKind = null,
          message = Toast(
            "Refund ${committed.receiptNo}: ${committed.total.toMajorString()} " +
              "approved by ${manager.displayName}",
          ),
        )
        SyncWorker.syncNow(context)
      }.onFailure {
        _state.value = _state.value.copy(
          busy = false,
          approvalPrompt = null,
          refundError = it.message ?: "Could not complete the refund",
        )
      }
    }
  }

  fun dismissMessage() {
    _state.value = _state.value.copy(message = null, lastReceiptNo = null, lastChange = null)
  }

  /**
   * Take cash and commit.
   *
   * Everything happens on device in one local transaction. The cashier is done
   * the moment this returns; the upload is somebody else's problem, later.
   */
  fun payCash(tendered: Money) {
    val cart = _state.value.cart
    if (cart.isEmpty) return

    if (cart.requiresAgeVerification) {
      _state.value = _state.value.copy(
        message = Toast(
          "${cart.minimumAgeRequired}+ ID required before payment",
          isError = true,
        ),
      )
      return
    }

    if (tendered < cart.total) {
      _state.value = _state.value.copy(
        message = Toast("Tendered is less than the total", isError = true),
      )
      return
    }

    viewModelScope.launch {
      _state.value = _state.value.copy(busy = true)
      try {
        val change = tendered - cart.total
        val committed = sales.commit(
          cart = cart,
          tenders = listOf(
            Tender(method = "cash", amount = cart.total, tendered = tendered, change = change),
          ),
          sessionId = _state.value.sessionId,
        )
        // Composed before the cart is cleared, because the cart *is* the
        // receipt. Resolved into a local first: see onSearch for what happens
        // when a suspending call is evaluated inside a state copy.
        val receipt = buildReceipt(cart, committed, tendered, change)

        _state.value = _state.value.copy(
          busy = false,
          cart = Cart.EMPTY,
          lastReceiptNo = committed.receiptNo,
          lastChange = committed.change,
          lastReceipt = receipt,
          message = Toast("Sale ${committed.receiptNo} saved on this device"),
        )
        // Enqueued AFTER the sale is committed, never before. The upload is a
        // consequence of a sale existing; a sale is never a consequence of an
        // upload succeeding.
        SyncWorker.syncNow(context)
      } catch (e: Exception) {
        // A failure here means the sale did not commit, so nothing was sold and
        // the cart is deliberately left intact for the cashier to retry.
        _state.value = _state.value.copy(
          busy = false,
          message = Toast(e.message ?: "Could not save the sale", isError = true),
        )
      }
    }
  }

  /**
   * Turn the sale that just completed into a receipt.
   *
   * The store's address, phone and return policy are shop configuration that
   * does not exist yet, so they are omitted rather than invented. A receipt
   * that states a return policy the shop never agreed to is worse than one that
   * states none.
   */
  private suspend fun buildReceipt(
    cart: Cart,
    committed: CommittedSale,
    tendered: Money,
    change: Money,
  ): SaleReceipt {
    val registerConfig = config.get()
    return SaleReceipt(
      store = ReceiptStore(name = registerConfig?.storeName ?: "SnapPOS"),
      receiptNo = committed.receiptNo,
      soldAt = Instant.now(),
      cashierName = _state.value.cashier?.displayName ?: "",
      registerName = "Register ${registerConfig?.registerCode ?: ""}".trim(),
      items = cart.effectiveLines.map { line ->
        ReceiptItem(
          description = line.description,
          quantity = line.quantity,
          unitPrice = line.unitPrice,
          lineTotal = line.total,
        )
      },
      subtotal = cart.subtotal,
      discount = cart.discountTotal,
      tax = cart.taxTotal,
      total = cart.total,
      tenders = listOf(ReceiptTender("cash", tendered)),
      change = change,
      minimumAge = cart.minimumAgeRequired,
      // The cart reached payment, so any age gate on it was satisfied — that is
      // what `requiresAgeVerification` blocking payment guarantees.
      ageVerified = cart.minimumAgeRequired != null,
    )
  }

  fun showReceipt() {
    if (_state.value.lastReceipt != null) {
      _state.value = _state.value.copy(showingReceipt = true)
    }
  }

  fun dismissReceipt() {
    _state.value = _state.value.copy(showingReceipt = false)
  }
}

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
import com.snappos.data.HoldRepository
import com.snappos.data.entities.HeldCartEntity
import com.snappos.data.Tender
import com.snappos.domain.Cart
import com.snappos.domain.Money
import com.snappos.domain.Uuid7
import com.snappos.sync.CatalogSync
import com.snappos.sync.CustomerDto
import com.snappos.sync.CustomerRepository
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
enum class ApprovalKind { Refund, VoidSale, TaxExemption }

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
  // ---------------------------------------------------------- price override
  val pendingTaxExemptReason: String? = null,
  val heldCarts: List<HeldCartEntity> = emptyList(),
  // ----------------------------------------------------------------- customer
  /** Who the sale is attached to, kept alongside `cart.customerId` so a name can be shown. */
  val attachedCustomer: CustomerDto? = null,
  val customerResults: List<CustomerDto> = emptyList(),
  val customerSearchBusy: Boolean = false,
  val customerError: String? = null,
)

/**
 * A price override waiting on a manager PIN.
 *
 * Held here rather than applied optimistically, because the authorizer's
 * name has to be on the change before it exists — an override with nobody's
 * name attached is indistinguishable from a mispriced product after the fact.
 */

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
  private val holds: HoldRepository,
  private val customers: CustomerRepository,
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
      holds.observe().collect { held ->
        _state.value = _state.value.copy(heldCarts = held)
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
    _state.value = _state.value.copy(cart = Cart.EMPTY, attachedCustomer = null, message = null)
  }

  fun holdCart(label: String) {
    val snapshot = _state.value
    val cashier = snapshot.cashier ?: return
    if (snapshot.cart.isEmpty) return
    viewModelScope.launch {
      _state.value = _state.value.copy(busy = true)
      runCatching { holds.hold(snapshot.cart, label, cashier.userId) }
        .onSuccess {
          _state.value = _state.value.copy(
            busy = false,
            cart = Cart.EMPTY,
            attachedCustomer = null,
            message = Toast("Sale held as ${label.trim()}")
          )
        }
        .onFailure { error ->
          _state.value = _state.value.copy(
            busy = false,
            message = Toast(error.message ?: "Could not hold sale", true),
          )
        }
    }
  }

  fun resumeHeldCart(id: String) {
    if (!_state.value.cart.isEmpty) {
      _state.value = _state.value.copy(message = Toast("Hold or clear the current sale first", true))
      return
    }
    viewModelScope.launch {
      _state.value = _state.value.copy(busy = true)
      val cart = holds.resume(id)
      if (cart == null) {
        _state.value = _state.value.copy(busy = false, message = Toast("That held sale is no longer available", true))
        return@launch
      }
      _state.value = _state.value.copy(busy = false, cart = cart, message = Toast("Held sale resumed"))

      // The hold carried the customer's id, never a name — a customer is
      // never cached, so the name shown before the hold is gone the moment
      // this ViewModel is. Best effort: if the lookup fails, the sale still
      // has the right customer_id, it just won't show a name until reattached.
      cart.customerId?.let { customerId ->
        customers.get(customerId).onSuccess { found ->
          _state.value = _state.value.copy(attachedCustomer = found)
        }
      }
    }
  }

  /**
   * Search for a customer to attach to the current sale.
   *
   * Exactly one of `phone` or `q` is meaningful to the server; the other is
   * left null rather than sent blank, matching what [CustomerRepository]
   * itself refuses. Every cashier can search — `customer.view` is granted to
   * the role by default — but only [createCustomer] is gated further.
   */
  fun searchCustomers(phone: String? = null, q: String? = null) {
    viewModelScope.launch {
      _state.value = _state.value.copy(customerSearchBusy = true, customerError = null)
      customers.search(phone = phone, q = q)
        .onSuccess { results ->
          _state.value = _state.value.copy(customerSearchBusy = false, customerResults = results)
        }
        .onFailure { error ->
          _state.value = _state.value.copy(
            customerSearchBusy = false,
            customerResults = emptyList(),
            customerError = error.message ?: "customer lookup failed",
          )
        }
    }
  }

  fun clearCustomerSearch() {
    _state.value = _state.value.copy(customerResults = emptyList(), customerError = null)
  }

  fun attachCustomer(customer: CustomerDto) {
    _state.value = _state.value.copy(
      cart = _state.value.cart.withCustomer(customer.id),
      attachedCustomer = customer,
      customerResults = emptyList(),
      customerSearchBusy = false,
      customerError = null,
    )
  }

  fun detachCustomer() {
    _state.value = _state.value.copy(cart = _state.value.cart.withCustomer(null), attachedCustomer = null)
  }

  /**
   * A new walk-in, added from the register.
   *
   * Gated on `customer.manage` server side; the button that calls this is
   * gated the same way client side, so a cashier without it never reaches a
   * refusal — same split as [overridePrice] draws between reading a
   * permission and reaching for a manager.
   */
  fun createCustomer(firstName: String?, lastName: String?, phone: String?, email: String?) {
    val cashier = _state.value.cashier ?: return
    if (!cashier.can("customer.manage")) {
      _state.value = _state.value.copy(customerError = "This employee cannot add customers")
      return
    }
    viewModelScope.launch {
      _state.value = _state.value.copy(customerSearchBusy = true, customerError = null)
      customers.create(firstName, lastName, phone, email)
        .onSuccess { created -> attachCustomer(created) }
        .onFailure { error ->
          _state.value = _state.value.copy(
            customerSearchBusy = false,
            customerError = error.message ?: "could not add that customer",
          )
        }
    }
  }

  /**
   * Override what a line rings up at.
   *
   * A permission check against the signed-in cashier, applied immediately —
   * the same shape as a line discount, not a manager PIN prompt. Gated on
   * `sale.price_override` rather than open to everyone: whoever assigns that
   * permission to a role decides who may reprice at the counter, but once an
   * employee holds it they can use it without stopping the sale to fetch a
   * second person.
   *
   * `Cart.overridePrice` re-runs `CartLine`'s own invariants on copy, so a
   * negative price is refused by the domain regardless of what the dialog let
   * through — this is not the only place that gets checked, just the first.
   */
  fun overridePrice(lineId: String, newPrice: Money, reason: String) {
    val cashier = _state.value.cashier ?: return
    if (!cashier.can("sale.price_override")) {
      _state.value = _state.value.copy(message = Toast("This employee cannot override a price", true))
      return
    }
    runCatching { _state.value.cart.overridePrice(lineId, newPrice, cashier.userId, reason) }
      .onSuccess { cart -> _state.value = _state.value.copy(cart = cart, message = Toast("Price overridden")) }
      .onFailure { error ->
        _state.value = _state.value.copy(message = Toast(error.message ?: "Invalid price override", true))
      }
  }

  fun discountLine(lineId: String, amount: Money, reason: String) {
    val cashier = _state.value.cashier ?: return
    if (!cashier.can("sale.discount_line")) {
      _state.value = _state.value.copy(message = Toast("This employee cannot discount items", true))
      return
    }
    runCatching { _state.value.cart.discountLine(lineId, amount, reason) }
      .onSuccess { cart ->
        _state.value = _state.value.copy(cart = cart, message = Toast("Discount applied"))
      }
      .onFailure { error ->
        _state.value = _state.value.copy(message = Toast(error.message ?: "Invalid discount", true))
      }
  }

  fun discountCart(amount: Money, reason: String) {
    val cashier = _state.value.cashier ?: return
    if (!cashier.can("sale.discount_cart")) {
      _state.value = _state.value.copy(message = Toast("This employee cannot discount a whole sale", true))
      return
    }
    runCatching { _state.value.cart.applyCartDiscount(amount, reason) }
      .onSuccess { cart -> _state.value = _state.value.copy(cart = cart, message = Toast("Cart discount applied")) }
      .onFailure { error ->
        _state.value = _state.value.copy(message = Toast(error.message ?: "Invalid cart discount", true))
      }
  }

  fun setSaleNote(note: String) {
    _state.value = _state.value.copy(cart = _state.value.cart.withNote(note))
  }

  fun requestTaxExemption(reason: String) {
    if (reason.isBlank()) {
      _state.value = _state.value.copy(message = Toast("Tax exemption requires a reason", true))
      return
    }
    _state.value = _state.value.copy(
      pendingTaxExemptReason = reason.trim(),
      approvalPrompt = "Approve tax-exempt sale",
      approvalKind = ApprovalKind.TaxExemption,
      approvalError = null,
    )
  }

  fun clearTaxExemption() {
    _state.value = _state.value.copy(cart = _state.value.cart.clearTaxExemption())
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
      pendingTaxExemptReason = null,
    )
  }

  /** One entry point; the pending action decides what the PIN authorises. */
  fun approve(pin: String) {
    when (_state.value.approvalKind) {
      ApprovalKind.Refund -> approveRefund(pin)
      ApprovalKind.VoidSale -> approveVoid(pin)
      ApprovalKind.TaxExemption -> approveTaxExemption(pin)
      null -> Unit
    }
  }

  private fun approveTaxExemption(pin: String) {
    val reason = _state.value.pendingTaxExemptReason ?: return
    viewModelScope.launch {
      _state.value = _state.value.copy(busy = true)
      val manager = shift.approve("sale.tax_exempt", pin)
      if (manager == null) {
        _state.value = _state.value.copy(busy = false, approvalError = "That PIN cannot approve tax exemption")
        return@launch
      }
      _state.value = _state.value.copy(
        busy = false,
        cart = _state.value.cart.exemptTax(reason),
        pendingTaxExemptReason = null,
        approvalPrompt = null,
        approvalKind = null,
        approvalError = null,
        message = Toast("Tax exemption approved by ${manager.displayName}"),
      )
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

  /** Take a single cash tender and commit. See [commitTenders] for what commit means. */
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

    val change = tendered - cart.total
    commitTenders(
      cart,
      listOf(Tender(method = "cash", amount = cart.total, tendered = tendered, change = change)),
    )
  }

  /**
   * Cover one sale with more than one tender.
   *
   * The tender list already sums to at least the cart total — [SplitPaymentDialog]
   * only lets a cashier confirm once its own running "remaining" reaches zero —
   * but this is re-checked here rather than trusted blindly, the same way
   * `payCash` re-checks `tendered < cart.total` instead of trusting the dialog
   * that computed it.
   */
  fun paySplit(tenders: List<Tender>) {
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

    val paid = Money.sum(tenders.map { it.amount })
    if (paid < cart.total) {
      _state.value = _state.value.copy(
        message = Toast("Tenders do not cover the total", isError = true),
      )
      return
    }

    commitTenders(cart, tenders)
  }

  /**
   * Take cash and commit.
   *
   * Everything happens on device in one local transaction. The cashier is done
   * the moment this returns; the upload is somebody else's problem, later.
   */
  private fun commitTenders(cart: Cart, tenders: List<Tender>) {
    viewModelScope.launch {
      _state.value = _state.value.copy(busy = true)
      try {
        val change = Money.sum(tenders.map { it.change })
        val committed = sales.commit(cart = cart, tenders = tenders, sessionId = _state.value.sessionId)
        // Composed before the cart is cleared, because the cart *is* the
        // receipt. Resolved into a local first: see onSearch for what happens
        // when a suspending call is evaluated inside a state copy.
        val receipt = buildReceipt(cart, committed, tenders, change)

        _state.value = _state.value.copy(
          busy = false,
          cart = Cart.EMPTY,
          attachedCustomer = null,
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
    tenders: List<Tender>,
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
      // Cash shows what was handed over, not the accounting amount: a $50
      // note against a $43 sale reads "cash $50.00 / change $7.00" on the
      // slip, which is what a customer expects to see, not "$43.00". Anything
      // else has no such distinction — it was for its exact amount.
      tenders = tenders.map { ReceiptTender(it.method, it.tendered ?: it.amount) },
      change = change,
      minimumAge = cart.minimumAgeRequired,
      // The cart reached payment, so any age gate on it was satisfied — that is
      // what `requiresAgeVerification` blocking payment guarantees.
      ageVerified = cart.minimumAgeRequired != null,
      customerName = _state.value.attachedCustomer?.displayName,
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

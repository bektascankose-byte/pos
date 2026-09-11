package com.snappos.pos.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.snappos.data.CatalogRepository
import com.snappos.data.Cashier
import com.snappos.data.CashRepository
import com.snappos.data.DevProvisioning
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
enum class RegisterStage { Locked, DrawerClosed, Selling }

data class RegisterUiState(
  val stage: RegisterStage = RegisterStage.Locked,
  val employees: List<EmployeeEntity> = emptyList(),
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
  val busy: Boolean = false,
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
  }

  private suspend fun loadTiles(categoryId: String?) {
    _state.value = _state.value.copy(tiles = catalog.byCategory(categoryId, limit = 60))
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
      _state.value = _state.value.copy(
        tiles = if (query.isBlank()) catalog.byCategory(_state.value.selectedCategoryId, 60)
        else catalog.search(query, 60),
      )
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
        _state.value = _state.value.copy(
          busy = false,
          cart = Cart.EMPTY,
          lastReceiptNo = committed.receiptNo,
          lastChange = committed.change,
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
}

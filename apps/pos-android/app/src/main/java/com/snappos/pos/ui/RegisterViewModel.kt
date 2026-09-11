package com.snappos.pos.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.snappos.data.CatalogRepository
import com.snappos.data.DevSeed
import com.snappos.data.ResolvedProduct
import com.snappos.data.SaleRepository
import com.snappos.data.Tender
import com.snappos.domain.Cart
import com.snappos.domain.Money
import com.snappos.domain.Uuid7
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/** A short lived message for the cashier. Not an error dialog; a line of text. */
data class Toast(val text: String, val isError: Boolean = false)

data class RegisterUiState(
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
  private val catalog: CatalogRepository,
  private val sales: SaleRepository,
  private val devSeed: DevSeed,
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
      devSeed.seedIfEmpty()
      taxRate = catalog.taxRate()
      loadTiles(null)
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
          cashierUserId = DevSeed.DEV_CASHIER_ID,
          sessionId = null,
        )
        _state.value = RegisterUiState(
          tiles = _state.value.tiles,
          categories = _state.value.categories,
          selectedCategoryId = _state.value.selectedCategoryId,
          lastReceiptNo = committed.receiptNo,
          lastChange = committed.change,
          message = Toast("Sale ${committed.receiptNo} saved on this device"),
        )
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

package com.snappos.pos.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PointOfSale
import androidx.compose.material.icons.automirrored.filled.ReceiptLong
import androidx.compose.material.icons.filled.RestartAlt
import androidx.compose.material.icons.filled.Percent
import androidx.compose.material.icons.filled.AttachMoney
import androidx.compose.material.icons.filled.PauseCircle
import androidx.compose.material.icons.filled.LocalOffer
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.snappos.data.ResolvedProduct
import com.snappos.domain.Cart
import com.snappos.domain.CartLine
import com.snappos.domain.Money

/**
 * The register.
 *
 * Layout from architecture section O: categories left, products centre, cart
 * right. Two rules here are load bearing and easy to erode later:
 *
 *  - **Zero animation on the scan-to-cart path.** A row that animates in is a
 *    row the cashier waits for. The budget is 120ms from HID input to rendered
 *    row.
 *  - **Tabular numerals on every money figure**, so price columns align and a
 *    changing total does not shimmer as digits change width.
 */
@Composable
fun RegisterScreen(viewModel: RegisterViewModel = hiltViewModel()) {
  val state by viewModel.state.collectAsStateWithLifecycle()
  val pending by viewModel.pendingUploads.collectAsStateWithLifecycle()
  val dead by viewModel.deadLetters.collectAsStateWithLifecycle()

  // Three gates, in order: who is on the register, is the drawer open, then
  // sell. Each one exists because the step after it is impossible without it —
  // a sale needs someone to attribute it to, and cash needs somewhere to go.
  when (state.stage) {
    RegisterStage.Locked -> {
      UnlockScreen(
        employees = state.employees,
        message = state.message?.text,
        busy = state.busy,
        onUnlock = viewModel::unlock,
        rosterDiagnosis = state.rosterDiagnosis,
      )
      return
    }
    RegisterStage.DrawerClosed -> {
      DrawerScreen(
        cashierName = state.cashier?.displayName ?: "",
        message = state.message,
        busy = state.busy,
        onOpen = viewModel::openDrawer,
        onLock = viewModel::lock,
      )
      return
    }
    RegisterStage.Refunding -> {
      RefundScreen(
        sale = state.refundSale,
        lookupError = state.refundError,
        selections = state.refundSelections,
        restockFlags = state.refundRestock,
        reasonCode = state.refundReason,
        busy = state.busy,
        onLookup = viewModel::lookupReceipt,
        onQuantity = viewModel::setRefundQuantity,
        onToggleRestock = viewModel::toggleRefundRestock,
        onReason = viewModel::setRefundReason,
        onSubmit = viewModel::requestRefundApproval,
        onCancel = viewModel::cancelRefund,
        onVoid = viewModel::requestVoidApproval,
      )
      state.approvalPrompt?.let { prompt ->
        ApprovalDialog(
          action = prompt,
          error = state.approvalError,
          onApprove = viewModel::approve,
          onDismiss = viewModel::dismissApproval,
        )
      }
      return
    }
    RegisterStage.Selling -> Unit
  }

  var showPayment by remember { mutableStateOf(false) }
  var showSplitPayment by remember { mutableStateOf(false) }
  var showClose by remember { mutableStateOf(false) }
  var selectedLineId by remember { mutableStateOf<String?>(null) }
  var showDiscount by remember { mutableStateOf(false) }
  var showCartDiscount by remember { mutableStateOf(false) }
  var showOverridePrice by remember { mutableStateOf(false) }
  var showHold by remember { mutableStateOf(false) }
  var showHeldSales by remember { mutableStateOf(false) }
  var showSaleDetails by remember { mutableStateOf(false) }
  var showCustomer by remember { mutableStateOf(false) }
  var showLineActions by remember { mutableStateOf(false) }
  var confirmClear by remember { mutableStateOf(false) }

  val syncState = when {
    dead > 0 -> SyncState.Error
    pending > 0 -> SyncState.Offline
    else -> SyncState.Online
  }

  Surface(color = MaterialTheme.colorScheme.background) {
    Column(Modifier.fillMaxSize().safeDrawingPadding()) {
      RegisterHeader(
        cashier = state.cashier?.displayName ?: "",
        register = "Register 1",
        state = syncState,
        pending = pending,
        onLock = viewModel::lock,
        onCloseDrawer = { showClose = true },
        onRefund = viewModel::startRefund,
        onReceipt = viewModel::showReceipt,
        hasReceipt = state.lastReceipt != null,
        heldCount = state.heldCarts.size,
        onHeldSales = { showHeldSales = true },
      )
      HorizontalDivider(color = MaterialTheme.colorScheme.outline)

      state.message?.let { message ->
        MessageBar(message, onDismiss = viewModel::dismissMessage)
      }

      BoxWithConstraints(Modifier.fillMaxSize()) {
        val compact = maxWidth < 900.dp
        val short = maxHeight < 520.dp

        Row(Modifier.fillMaxSize()) {
          CategoryRail(
            categories = state.categories,
            selectedId = state.selectedCategoryId,
            onSelect = viewModel::selectCategory,
            modifier = Modifier.width(if (compact) 116.dp else 160.dp).fillMaxHeight(),
          )
          VerticalLine()
          Column(Modifier.weight(1f).fillMaxHeight()) {
            ScanField(onQueryChange = viewModel::onSearch, onSubmit = viewModel::onScan)
            ProductGrid(
              tiles = state.tiles,
              onTap = { viewModel.addToCart(it) },
              modifier = Modifier.fillMaxSize(),
              tileWidth = if (compact) 104.dp else 140.dp,
            )
          }
          VerticalLine()
          CartPanel(
            cart = state.cart,
            compact = short,
            busy = state.busy,
            onRemove = viewModel::removeLine,
            onQuantity = viewModel::setQuantity,
            onVerifyAge = viewModel::confirmAgeVerified,
            onPay = { showPayment = true },
            selectedLineId = selectedLineId,
            onSelectLine = {
              selectedLineId = it
              showLineActions = true
            },
            onDiscount = { showDiscount = true },
            onCartDiscount = { showCartDiscount = true },
            onOverridePrice = { showOverridePrice = true },
            onClear = { confirmClear = true },
            onHold = { showHold = true },
            onSaleDetails = { showSaleDetails = true },
            customerName = state.attachedCustomer?.displayName,
            onOpenCustomer = { showCustomer = true },
            modifier = Modifier.width(if (compact) 280.dp else 340.dp).fillMaxHeight(),
          )
        }
      }
    }
  }

  if (state.showingReceipt) {
    state.lastReceipt?.let { receipt ->
      ReceiptSheet(receipt = receipt, onDismiss = viewModel::dismissReceipt)
    }
  }

  if (showClose) {
    // Reuses the cash dialog: counting a drawer and taking a tender are the
    // same gesture, and a cashier should not have to learn two keypads.
    CashPaymentDialog(
      total = Money.ZERO,
      title = "Count the drawer",
      confirmLabel = "CLOSE DRAWER",
      onDismiss = { showClose = false },
      onConfirm = { counted ->
        showClose = false
        viewModel.closeDrawer(counted)
      },
    )
  }

  if (showPayment) {
    CashPaymentDialog(
      total = state.cart.total,
      onDismiss = { showPayment = false },
      onConfirm = { tendered ->
        showPayment = false
        viewModel.payCash(tendered)
      },
      onSplitPayment = {
        showPayment = false
        showSplitPayment = true
      },
    )
  }

  if (showSplitPayment) {
    SplitPaymentDialog(
      total = state.cart.total,
      onDismiss = { showSplitPayment = false },
      onConfirm = { tenders ->
        showSplitPayment = false
        viewModel.paySplit(tenders)
      },
    )
  }

  if (showDiscount) {
    state.cart.lines.firstOrNull { it.id == selectedLineId }?.let { line ->
      DiscountDialog(
        lineName = line.description,
        maximum = line.gross - line.discount,
        basis = line.gross,
        onDismiss = { showDiscount = false },
        onApply = { amount, reason ->
          viewModel.discountLine(line.id, amount, reason)
          showDiscount = false
        },
      )
    } ?: run { showDiscount = false }
  }

  if (showLineActions) {
    state.cart.lines.firstOrNull { it.id == selectedLineId }?.let { line ->
      LineActionsDialog(
        lineName = line.description,
        onDismiss = { showLineActions = false },
        onDiscount = { showLineActions = false; showDiscount = true },
        onOverride = { showLineActions = false; showOverridePrice = true },
      )
    } ?: run { showLineActions = false }
  }

  if (showCartDiscount) {
    val available = Money.sum(state.cart.lines.map { it.taxable })
    DiscountDialog(
      title = "Discount entire sale",
      lineName = "Applies proportionally across every item for accurate tax and refunds.",
      maximum = available,
      basis = available,
      allowTarget = true,
      onDismiss = { showCartDiscount = false },
      onApply = { amount, reason ->
        viewModel.discountCart(amount, reason)
        showCartDiscount = false
      },
    )
  }

  if (showOverridePrice) {
    state.cart.lines.firstOrNull { it.id == selectedLineId }?.let { line ->
      OverridePriceDialog(
        lineName = line.description,
        currentPrice = line.unitPrice,
        onDismiss = { showOverridePrice = false },
        onApply = { newPrice, reason ->
          viewModel.overridePrice(line.id, newPrice, reason)
          showOverridePrice = false
        },
      )
    } ?: run { showOverridePrice = false }
  }

  if (showHold) {
    HoldSaleDialog(
      onDismiss = { showHold = false },
      onHold = { label ->
        showHold = false
        selectedLineId = null
        viewModel.holdCart(label)
      },
    )
  }

  if (showHeldSales) {
    HeldSalesDialog(
      held = state.heldCarts,
      onDismiss = { showHeldSales = false },
      onResume = { id ->
        showHeldSales = false
        selectedLineId = null
        viewModel.resumeHeldCart(id)
      },
    )
  }

  if (showSaleDetails) {
    SaleDetailsDialog(
      currentNote = state.cart.note,
      currentlyTaxExempt = state.cart.taxExempt,
      onDismiss = { showSaleDetails = false },
      onSave = { note, exempt, reason ->
        showSaleDetails = false
        viewModel.setSaleNote(note)
        when {
          exempt && !state.cart.taxExempt -> viewModel.requestTaxExemption(reason)
          !exempt && state.cart.taxExempt -> viewModel.clearTaxExemption()
        }
      },
    )
  }

  if (showCustomer) {
    CustomerDialog(
      attached = state.attachedCustomer,
      results = state.customerResults,
      busy = state.customerSearchBusy,
      error = state.customerError,
      onDismiss = {
        showCustomer = false
        viewModel.clearCustomerSearch()
      },
      onSearch = viewModel::searchCustomers,
      onClearSearch = viewModel::clearCustomerSearch,
      onAttach = { customer ->
        viewModel.attachCustomer(customer)
        showCustomer = false
      },
      onDetach = {
        viewModel.detachCustomer()
        showCustomer = false
      },
      onCreate = viewModel::createCustomer,
    )
  }

  // Tax exemption is requested from the selling stage, not the refund stage,
  // so it needs its own mount of the same approval prompt refunds and voids
  // use — otherwise the manager PIN prompt would have nowhere to render. A
  // price override no longer goes through this: it applies immediately,
  // gated on sale.price_override like a line discount is gated on
  // sale.discount_line, not on a manager PIN.
  state.approvalPrompt?.let { prompt ->
    if (state.approvalKind == ApprovalKind.TaxExemption) {
      ApprovalDialog(
        action = prompt,
        error = state.approvalError,
        onApprove = viewModel::approve,
        onDismiss = viewModel::dismissApproval,
      )
    }
  }

  if (confirmClear) {
    AlertDialog(
      onDismissRequest = { confirmClear = false },
      shape = RoundedCornerShape(20.dp),
      title = { Text("Clear this sale?") },
      text = { Text("Every item and discount in the current cart will be removed.") },
      confirmButton = {
        Button(onClick = {
          viewModel.clearCart()
          selectedLineId = null
          confirmClear = false
        }) { Text("Clear sale") }
      },
      dismissButton = { OutlinedButton(onClick = { confirmClear = false }) { Text("Keep sale") } },
    )
  }
}

enum class SyncState { Online, Syncing, Offline, Error }

@Composable
private fun RegisterHeader(
  cashier: String,
  register: String,
  state: SyncState,
  pending: Int,
  onLock: () -> Unit,
  onCloseDrawer: () -> Unit,
  onRefund: () -> Unit,
  onReceipt: () -> Unit,
  hasReceipt: Boolean,
  heldCount: Int,
  onHeldSales: () -> Unit,
) {
  Row(
    Modifier
      .fillMaxWidth()
      .background(MaterialTheme.colorScheme.surface)
      .padding(horizontal = Space.M.dp, vertical = Space.XS.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Surface(
      color = MaterialTheme.colorScheme.primary,
      shape = RoundedCornerShape(10.dp),
      modifier = Modifier.size(42.dp),
    ) { Box(contentAlignment = Alignment.Center) { Icon(Icons.Default.PointOfSale, "SnapPOS") } }
    Spacer(Modifier.width(Space.S.dp))
    Column {
      Text("SnapPOS", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
      Text(register, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    Spacer(Modifier.width(Space.L.dp))
    SyncPill(state, pending)
    Spacer(Modifier.width(Space.M.dp))
    Text(
      cashier,
      style = MaterialTheme.typography.bodyMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.weight(1f))
    // Only once there is a sale to show one for. A receipt button that opens
    // nothing teaches a cashier to stop trusting the button.
    if (hasReceipt) {
      IconButton(onClick = onReceipt) { Icon(Icons.AutoMirrored.Filled.ReceiptLong, "Last receipt") }
    }
    TextButton(onClick = onHeldSales) { Text("Holds${if (heldCount > 0) " ($heldCount)" else ""}") }
    TextButton(onClick = onRefund) { Text("Returns") }
    TextButton(onClick = onCloseDrawer) { Text("Close shift") }
    IconButton(onClick = onLock) { Icon(Icons.Default.Lock, "Lock register") }
  }
}

/**
 * The sync pill, always visible.
 *
 * **Offline is amber, deliberately not red.** Offline is a normal, safe
 * operating mode — the sale is saved on this device — and the interface must
 * not communicate panic about it. Red is reserved for a sync error, the only
 * state that actually needs a person.
 */
@Composable
private fun SyncPill(state: SyncState, pending: Int) {
  val (label, color) = when (state) {
    SyncState.Online -> "Online" to MaterialTheme.colorScheme.tertiary
    SyncState.Syncing -> "Syncing" to MaterialTheme.colorScheme.primary
    SyncState.Offline -> "$pending pending" to MaterialTheme.colorScheme.secondary
    SyncState.Error -> "Sync Error" to MaterialTheme.colorScheme.error
  }
  Row(verticalAlignment = Alignment.CenterVertically) {
    Box(Modifier.size(8.dp).clip(CircleShape).background(color))
    Spacer(Modifier.width(Space.S.dp))
    Text(label, style = MaterialTheme.typography.labelMedium, color = color)
  }
}

@Composable
private fun MessageBar(message: Toast, onDismiss: () -> Unit) {
  val foreground =
    if (message.isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.tertiary

  Row(
    Modifier
      .fillMaxWidth()
      .background(foreground.copy(alpha = 0.15f))
      .padding(horizontal = Space.M.dp, vertical = Space.S.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      message.text,
      style = MaterialTheme.typography.bodyMedium,
      color = foreground,
      modifier = Modifier.weight(1f),
    )
    TextButton(onClick = onDismiss) { Text("Dismiss") }
  }
}

@Composable
private fun CategoryRail(
  categories: List<CategoryTile>,
  selectedId: String?,
  onSelect: (String?) -> Unit,
  modifier: Modifier = Modifier,
) {
  LazyColumn(modifier.background(MaterialTheme.colorScheme.surface).padding(Space.S.dp)) {
    item { SectionLabel("SHOP") }
    item { RailRow("All", selectedId == null) { onSelect(null) } }
    items(categories) { category ->
      RailRow(category.name, selectedId == category.id) { onSelect(category.id) }
    }
  }
}

@Composable
private fun RailRow(label: String, selected: Boolean, onClick: () -> Unit) {
  Box(
    Modifier
      .fillMaxWidth()
      .height(Touch.MIN.dp)
      .clip(RoundedCornerShape(12.dp))
      .background(
        if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)
        else Color.Transparent,
      )
      .clickable(onClick = onClick)
      .padding(horizontal = Space.M.dp),
    contentAlignment = Alignment.CenterStart,
  ) {
    Text(
      label,
      style = MaterialTheme.typography.bodyLarge,
      color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onBackground,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

@Composable
private fun ProductGrid(
  tiles: List<ResolvedProduct>,
  onTap: (ResolvedProduct) -> Unit,
  modifier: Modifier = Modifier,
  tileWidth: Dp = Touch.TILE.dp,
) {
  LazyVerticalGrid(
    columns = GridCells.Adaptive(minSize = tileWidth),
    modifier = modifier.padding(horizontal = Space.M.dp),
    horizontalArrangement = Arrangement.spacedBy(Space.S.dp),
    verticalArrangement = Arrangement.spacedBy(Space.S.dp),
  ) {
    items(tiles, key = { it.variantId }) { tile -> ProductTileCard(tile) { onTap(tile) } }
  }
}

@Composable
private fun ProductTileCard(tile: ResolvedProduct, onTap: () -> Unit) {
  Column(
    Modifier
      .height(132.dp)
      .clip(RoundedCornerShape(16.dp))
      .background(MaterialTheme.colorScheme.surface)
      .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = .8f), RoundedCornerShape(16.dp))
      .clickable(onClick = onTap)
      .padding(Space.S.dp),
    verticalArrangement = Arrangement.SpaceBetween,
  ) {
    Column {
      Text(
        tile.productName,
        style = MaterialTheme.typography.bodyMedium,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
      )
      tile.variantName?.let {
        Text(
          it,
          style = MaterialTheme.typography.labelMedium,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
    }
    Row(
      Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
        tile.price?.let { "$${it.toMajorString()}" } ?: "No price",
        style = MaterialTheme.typography.titleLarge.merge(MoneyTextStyle),
        color = if (tile.price == null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
      )
      // A bare red "0" beside the price read as "24.990". An out of stock
      // marker has to be unmistakably not part of the number.
      if (!tile.inStock) {
        Text(
          "OUT",
          style = MaterialTheme.typography.labelMedium,
          color = MaterialTheme.colorScheme.error,
          modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(MaterialTheme.colorScheme.error.copy(alpha = 0.15f))
            .padding(horizontal = Space.S.dp, vertical = 2.dp),
        )
      }
    }
  }
}

@Composable
private fun CartPanel(
  cart: Cart,
  compact: Boolean,
  busy: Boolean,
  onRemove: (String) -> Unit,
  onQuantity: (String, Int) -> Unit,
  onVerifyAge: () -> Unit,
  onPay: () -> Unit,
  selectedLineId: String?,
  onSelectLine: (String) -> Unit,
  onDiscount: () -> Unit,
  onCartDiscount: () -> Unit,
  onOverridePrice: () -> Unit,
  onClear: () -> Unit,
  onHold: () -> Unit,
  onSaleDetails: () -> Unit,
  customerName: String?,
  onOpenCustomer: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Column(modifier.background(MaterialTheme.colorScheme.surface)) {
    Row(
      Modifier.fillMaxWidth().padding(if (compact) Space.S.dp else Space.M.dp),
      horizontalArrangement = Arrangement.SpaceBetween,
    ) {
      Column {
        Text("Current sale", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        // The existing subtitle line made clickable rather than a new row
        // added beside it — the compact layout has no vertical room to spare
        // for one, the same lesson the header overflow above already taught.
        Text(
          "${customerName ?: "Walk-in customer"}  •  ${cart.itemCount} ${if (cart.itemCount == 1) "item" else "items"}",
          style = MaterialTheme.typography.labelMedium,
          color = if (customerName != null) MaterialTheme.colorScheme.primary
          else MaterialTheme.colorScheme.onSurfaceVariant,
          modifier = Modifier.clickable(onClick = onOpenCustomer),
        )
      }
    }
    if (compact) {
      // A row of its own, not squeezed onto the title's line. Four 48dp
      // minimum touch targets plus the title text do not both fit inside a
      // 280dp panel: crammed onto one line, the last icon silently clipped
      // off the edge of the screen with no error and no way to reach it —
      // "Sale notes and tax exemption" was unreachable on every compact
      // device before this. Splitting the rows costs one line of height and
      // guarantees every action stays reachable regardless of how many are
      // ever added.
      Row(
        Modifier.fillMaxWidth().padding(horizontal = Space.S.dp, vertical = Space.XS.dp),
        horizontalArrangement = Arrangement.SpaceEvenly,
      ) {
        IconButton(onClick = onHold, enabled = !cart.isEmpty) {
          Icon(Icons.Default.PauseCircle, "Hold current sale")
        }
        IconButton(onClick = onCartDiscount, enabled = !cart.isEmpty) {
          Icon(Icons.Default.LocalOffer, "Discount entire sale")
        }
        IconButton(onClick = onClear, enabled = !cart.isEmpty) {
          Icon(Icons.Default.RestartAlt, "Clear sale")
        }
        IconButton(onClick = onSaleDetails) {
          Icon(Icons.Default.MoreVert, "Sale notes and tax exemption")
        }
      }
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outline)

    if (!compact) {
      Row(
        Modifier.fillMaxWidth().padding(horizontal = Space.S.dp, vertical = Space.XS.dp),
        horizontalArrangement = Arrangement.spacedBy(Space.XS.dp),
      ) {
        RegisterAction(
          label = "Hold",
          icon = { Icon(Icons.Default.PauseCircle, null) },
          enabled = !cart.isEmpty,
          onClick = onHold,
          modifier = Modifier.weight(1f),
        )
        RegisterAction(
          label = "Discount",
          icon = { Icon(Icons.Default.Percent, null) },
          enabled = selectedLineId != null,
          onClick = onDiscount,
          modifier = Modifier.weight(1f),
        )
        RegisterAction(
          label = "Cart off",
          icon = { Icon(Icons.Default.LocalOffer, null) },
          enabled = !cart.isEmpty,
          onClick = onCartDiscount,
          modifier = Modifier.weight(1f),
        )
        RegisterAction(
          label = "Override",
          icon = { Icon(Icons.Default.AttachMoney, null) },
          enabled = selectedLineId != null,
          onClick = onOverridePrice,
          modifier = Modifier.weight(1f),
        )
        RegisterAction(
          label = "Clear",
          icon = { Icon(Icons.Default.RestartAlt, null) },
          enabled = !cart.isEmpty,
          onClick = onClear,
          modifier = Modifier.weight(1f),
        )
        RegisterAction(
          label = "Details",
          icon = { Icon(Icons.Default.MoreVert, null) },
          enabled = true,
          onClick = onSaleDetails,
          modifier = Modifier.weight(1f),
        )
      }
      HorizontalDivider(color = MaterialTheme.colorScheme.outline)
    }

    LazyColumn(Modifier.weight(1f).heightIn(min = 88.dp)) {
      items(cart.effectiveLines, key = { it.id }) { line ->
        CartRow(
          line,
          compact = compact,
          selected = selectedLineId == line.id,
          onSelect = { onSelectLine(line.id) },
          onRemove = { onRemove(line.id) },
          onQuantity = { onQuantity(line.id, it) },
        )
      }
      if (cart.isEmpty) item { EmptyCart() }
    }

    HorizontalDivider(color = MaterialTheme.colorScheme.outline)

    if (cart.requiresAgeVerification && !compact) {
      AgeGate(cart.minimumAgeRequired ?: 21, compact, onVerifyAge)
    }

    Column(Modifier.padding(if (compact) Space.S.dp else Space.M.dp)) {
      TotalRow("Subtotal", cart.subtotal)
      if (!cart.discountTotal.isZero) TotalRow("Discount", -cart.discountTotal)
      TotalRow("Tax", cart.taxTotal)
      Spacer(Modifier.height(Space.S.dp))
      TotalRow("TOTAL", cart.total, emphasised = true)
      Spacer(Modifier.height(if (compact) Space.S.dp else Space.M.dp))
      Button(
        onClick = if (cart.requiresAgeVerification) onVerifyAge else onPay,
        enabled = !cart.isEmpty && !busy,
        // Never below the 56dp minimum even when squeezed: PAY is the most
        // pressed control in the building.
        modifier = Modifier
          .fillMaxWidth()
          .height(if (compact) Touch.MIN.dp else Touch.PRIMARY.dp),
        shape = RoundedCornerShape(14.dp),
        colors = ButtonDefaults.buttonColors(
          containerColor = if (cart.requiresAgeVerification) MaterialTheme.colorScheme.secondary
          else MaterialTheme.colorScheme.primary,
        ),
      ) {
        Text(
          if (cart.requiresAgeVerification) {
            "VERIFY ${cart.minimumAgeRequired ?: 21}+ ID"
          } else {
            "CHARGE  $${cart.total.toMajorString()}"
          },
          style = MaterialTheme.typography.titleLarge.merge(MoneyTextStyle),
          fontWeight = FontWeight.Bold,
        )
      }
    }
  }
}

/**
 * The age gate.
 *
 * Blocks PAY rather than warning beside it. A prompt a cashier can tap past
 * during a rush is not a compliance control, it is a suggestion.
 */
@Composable
private fun AgeGate(minimumAge: Int, compact: Boolean, onVerify: () -> Unit) {
  val background = Modifier
    .fillMaxWidth()
    .background(MaterialTheme.colorScheme.secondary.copy(alpha = 0.15f))
    .padding(if (compact) Space.S.dp else Space.M.dp)

  if (compact) {
    Row(background, verticalAlignment = Alignment.CenterVertically) {
      Text(
        "$minimumAge+ ID REQUIRED",
        style = MaterialTheme.typography.titleLarge,
        color = MaterialTheme.colorScheme.secondary,
        modifier = Modifier.weight(1f),
      )
      Button(
        onClick = onVerify,
        modifier = Modifier.height(Touch.MIN.dp),
        shape = RoundedCornerShape(10.dp),
        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondary),
      ) { Text("ID CHECKED", fontWeight = FontWeight.SemiBold) }
    }
  } else {
    Column(background) {
      Text(
        "$minimumAge+ ID REQUIRED",
        style = MaterialTheme.typography.titleLarge,
        color = MaterialTheme.colorScheme.secondary,
      )
      Spacer(Modifier.height(Space.S.dp))
      Button(
        onClick = onVerify,
        modifier = Modifier.fillMaxWidth().height(Touch.MIN.dp),
        shape = RoundedCornerShape(10.dp),
        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondary),
      ) {
        Text("ID CHECKED", fontWeight = FontWeight.SemiBold)
      }
    }
  }
}

@Composable
private fun CartRow(
  line: CartLine,
  compact: Boolean,
  selected: Boolean,
  onSelect: () -> Unit,
  onRemove: () -> Unit,
  onQuantity: (Int) -> Unit,
) {
  if (compact) {
    Row(
      Modifier.fillMaxWidth()
        .height(Touch.MIN.dp)
        .background(if (selected) MaterialTheme.colorScheme.primary.copy(alpha = .10f) else MaterialTheme.colorScheme.surface)
        .clickable(onClick = onSelect)
        .padding(horizontal = Space.S.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Column(Modifier.weight(1f)) {
        Text(line.description, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
          "${line.quantity} × ${line.unitPrice.toMajorString()}",
          style = MaterialTheme.typography.labelMedium.merge(MoneyTextStyle),
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
      QuantityButton("−") { onQuantity(line.quantity - 1) }
      Spacer(Modifier.width(Space.XS.dp))
      QuantityButton("+") { onQuantity(line.quantity + 1) }
      Spacer(Modifier.width(Space.S.dp))
      Text(line.total.toMajorString(), style = MaterialTheme.typography.bodyLarge.merge(MoneyTextStyle))
      TextButton(onClick = onRemove) { Text("×", style = MaterialTheme.typography.titleLarge) }
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.4f))
    return
  }

  Column(
    Modifier.fillMaxWidth()
      .background(if (selected) MaterialTheme.colorScheme.primary.copy(alpha = .10f) else MaterialTheme.colorScheme.surface)
      .clickable(onClick = onSelect)
      .padding(horizontal = Space.M.dp, vertical = Space.S.dp),
  ) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
      Text(
        line.description,
        style = MaterialTheme.typography.bodyLarge,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.weight(1f),
      )
      TextButton(onClick = onRemove) { Text("×", style = MaterialTheme.typography.titleLarge) }
    }
    Row(
      Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        QuantityButton("−") { onQuantity(line.quantity - 1) }
        Text(
          "${line.quantity} × ${line.unitPrice.toMajorString()}",
          style = MaterialTheme.typography.bodyMedium.merge(MoneyTextStyle),
          color = MaterialTheme.colorScheme.onSurfaceVariant,
          modifier = Modifier.padding(horizontal = Space.S.dp),
        )
        QuantityButton("+") { onQuantity(line.quantity + 1) }
      }
      Text(line.total.toMajorString(), style = MaterialTheme.typography.bodyLarge.merge(MoneyTextStyle))
    }
    line.minimumAge?.let { age ->
      Text(
        if (line.ageVerified) "$age+ verified" else "$age+ ID required",
        style = MaterialTheme.typography.labelMedium,
        color = if (line.ageVerified) MaterialTheme.colorScheme.tertiary
        else MaterialTheme.colorScheme.secondary,
      )
    }
  }
  HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.4f))
}

@Composable
private fun QuantityButton(label: String, onClick: () -> Unit) {
  Box(
    Modifier
      .size(36.dp)
      .clip(RoundedCornerShape(6.dp))
      .background(MaterialTheme.colorScheme.surfaceVariant)
      .clickable(onClick = onClick),
    contentAlignment = Alignment.Center,
  ) {
    Text(label, style = MaterialTheme.typography.titleLarge)
  }
}

@Composable
private fun RegisterAction(
  label: String,
  icon: @Composable () -> Unit,
  enabled: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  OutlinedButton(
    onClick = onClick,
    enabled = enabled,
    modifier = modifier.height(Touch.MIN.dp),
    shape = RoundedCornerShape(12.dp),
    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = Space.S.dp),
  ) {
    icon()
    Spacer(Modifier.width(Space.XS.dp))
    Text(label, maxLines = 1)
  }
}

@Composable
private fun EmptyCart() {
  Column(
    Modifier.fillMaxWidth().padding(horizontal = Space.L.dp, vertical = Space.XL.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Icon(
      Icons.Default.PointOfSale,
      contentDescription = null,
      tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .45f),
      modifier = Modifier.size(42.dp),
    )
    Spacer(Modifier.height(Space.S.dp))
    Text("Ready to ring", style = MaterialTheme.typography.titleLarge)
    Text(
      "Scan a barcode or tap a product",
      style = MaterialTheme.typography.bodyMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
  }
}

@Composable
private fun TotalRow(label: String, amount: Money, emphasised: Boolean = false) {
  Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
    Text(
      label,
      style = if (emphasised) MaterialTheme.typography.titleLarge else MaterialTheme.typography.bodyMedium,
      color = if (emphasised) MaterialTheme.colorScheme.onSurface
      else MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Text(
      amount.toMajorString(),
      style = (if (emphasised) MaterialTheme.typography.titleLarge else MaterialTheme.typography.bodyMedium)
        .merge(MoneyTextStyle),
    )
  }
}

@Composable
private fun SectionLabel(text: String) {
  Text(
    text,
    style = MaterialTheme.typography.labelMedium,
    color = MaterialTheme.colorScheme.onSurfaceVariant,
    modifier = Modifier.padding(horizontal = Space.M.dp, vertical = Space.S.dp),
  )
}

@Composable
private fun VerticalLine() {
  Box(Modifier.width(1.dp).fillMaxHeight().background(MaterialTheme.colorScheme.outline))
}

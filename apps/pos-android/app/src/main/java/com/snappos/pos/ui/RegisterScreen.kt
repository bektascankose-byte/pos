package com.snappos.pos.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ReceiptLong
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.snappos.data.QuickTab
import com.snappos.data.QuickTabKind
import com.snappos.domain.Cart
import com.snappos.domain.CartLine
import com.snappos.domain.Money
import com.snappos.domain.PaperWidth

/**
 * The register.
 *
 * Four columns, left to right: where you are, what you are picking from, what
 * the customer is buying, what you can do to it. The order is the order a sale
 * happens in and a cashier's hand travels it once per item.
 *
 * Two rules here are load bearing and easy to erode later:
 *
 *  - **Zero animation on the scan-to-cart path.** A row that animates in is a
 *    row the cashier waits for. The budget is 120ms from HID input to rendered
 *    row. Everything that does move on this screen moves because the cashier
 *    asked it to.
 *  - **Tabular numerals on every money figure**, so price columns align and a
 *    changing total does not shimmer as digits change width.
 */
@Composable
fun RegisterScreen(viewModel: RegisterViewModel = hiltViewModel()) {
  val state by viewModel.state.collectAsStateWithLifecycle()
  val pending by viewModel.pendingUploads.collectAsStateWithLifecycle()
  val dead by viewModel.deadLetters.collectAsStateWithLifecycle()
  val failedUploads by viewModel.failedUploads.collectAsStateWithLifecycle()

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
  var showCardPayment by remember { mutableStateOf(false) }
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
  var showSyncProblems by remember { mutableStateOf(false) }

  // Any tap anywhere counts as the counter being busy. Bumping a counter is
  // cruder than tracking real gestures and it is also the only version that
  // cannot be forgotten when a new control is added.
  var touches by remember { mutableStateOf(0) }
  val idle = rememberIdle(
    // The draft counts because typing happens on the keyboard's own window,
    // where the tap counter below never sees it.
    activity = listOf(touches, state.cart.itemCount, state.selectedLineId, state.selectedCategoryId, state.searchDraft),
    enabled = state.cart.isEmpty && !showPayment && !showSplitPayment && !showCardPayment,
  )

  val syncState = when {
    dead > 0 -> SyncState.Error
    pending > 0 -> SyncState.Offline
    else -> SyncState.Online
  }

  val nav = state.navigation
  val brands = nav.brandsIn(state.selectedCategoryId)
  val lines = state.selectedBrandId?.let { nav.linesIn(it, state.selectedCategoryId) }.orEmpty()
  val openLine = nav.line(state.selectedLineId)
  val pinnedIds = state.quickTabs
    .filter { it.kind == QuickTabKind.Product }
    .mapNotNull { it.target }
    .toSet()

  Surface(
    color = MaterialTheme.colorScheme.background,
    // Observed in the initial pass and never consumed, so this counts taps
    // without becoming a giant invisible button over the whole register.
    modifier = Modifier.pointerInput(Unit) {
      awaitPointerEventScope {
        while (true) {
          awaitPointerEvent(PointerEventPass.Initial)
          touches++
        }
      }
    },
  ) {
    Column(Modifier.fillMaxSize().safeDrawingPadding()) {
      RegisterHeader(
        cashier = state.cashier?.displayName ?: "",
        storeName = state.storeName.ifBlank { "Register" },
        state = syncState,
        pending = pending,
        onSyncProblems = { showSyncProblems = true },
        onLock = viewModel::lock,
        onCloseDrawer = { showClose = true },
        onRefund = viewModel::startRefund,
        onReceipt = viewModel::showReceipt,
        hasReceipt = state.lastReceipt != null,
        heldCount = state.heldCarts.size,
        onHeldSales = { showHeldSales = true },
      )

      state.message?.let { message ->
        MessageBar(message, onDismiss = viewModel::dismissMessage)
      }

      BoxWithConstraints(Modifier.fillMaxSize()) {
        val compact = maxWidth < 1100.dp
        val cartWidth = if (compact) 300.dp else 372.dp
        val railWidth = if (compact) 150.dp else 190.dp
        val actionWidth = if (compact) 78.dp else 92.dp

        Row(Modifier.fillMaxSize()) {
          NavRail(
            quickTabs = state.quickTabs,
            pinnedProducts = state.pinnedProducts,
            parts = nav.parts,
            categories = state.categories,
            selectedCategoryId = state.selectedCategoryId,
            hasSelection = state.selectedBrandId != null || state.selectedLineId != null,
            onQuickTab = viewModel::openQuickTab,
            onReorderQuick = viewModel::reorderQuickTabs,
            onRemoveQuick = viewModel::removeQuickTab,
            onCategory = viewModel::selectCategory,
            modifier = Modifier.width(railWidth).fillMaxHeight(),
          )
          VerticalLine()

          Box(Modifier.weight(1f).fillMaxHeight()) {
            Column(Modifier.fillMaxSize()) {
              ScanField(
                clearSignal = state.searchEpoch,
                onQueryChange = viewModel::onSearch,
                onSubmit = viewModel::onSubmit,
                onHeard = viewModel::onVoiceSearch,
                onVoiceProblem = viewModel::voiceProblem,
              )
              val searching = state.activeSearch.isNotBlank()

              // The chip rows are gone from the browse path on purpose.
              //
              // A chip is a filter over a list that is already on screen, and
              // it left the cashier looking at a hundred and thirty-four
              // products the moment they touched a category. Browsing is
              // folders now -- brand, then model, then flavour -- and the
              // grid below shows exactly one of those three levels.
              //
              // The chips survive only above search results, where they are
              // genuinely a filter and there is no folder to be inside of.
              // The search chip stands where the breadcrumb does, so swapping
              // one for the other does not move the grid under a finger.
              if (searching) {
                SearchChip(
                  term = state.activeSearch,
                  count = state.tiles.size,
                  onClear = viewModel::clearSearch,
                )
              }

              ChipRow(visible = brands.isNotEmpty() && searching) {
                BrandChips(brands, state.selectedBrandId, viewModel::selectBrand)
              }

              if (!searching) Breadcrumb(
                categoryName = state.categories.firstOrNull { it.id == state.selectedCategoryId }?.name,
                brandName = brands.firstOrNull { it.id == state.selectedBrandId }?.name,
                lineName = openLine?.name,
                count = state.tiles.size,
                pinnable = state.cashier != null,
                pinned = state.quickTabs.any { it.matches(state) },
                onPin = {
                  when {
                    state.selectedLineId != null -> viewModel.toggleQuickTab(
                      QuickTabKind.Line,
                      state.selectedLineId,
                      listOfNotNull(openLine?.brandName, openLine?.name).joinToString(" "),
                    )
                    state.selectedBrandId != null -> viewModel.toggleQuickTab(
                      QuickTabKind.Brand,
                      state.selectedBrandId,
                      brands.firstOrNull { it.id == state.selectedBrandId }?.name.orEmpty(),
                    )
                    state.selectedCategoryId != null -> viewModel.toggleQuickTab(
                      QuickTabKind.Category,
                      state.selectedCategoryId,
                      state.categories.firstOrNull { it.id == state.selectedCategoryId }?.name.orEmpty(),
                    )
                    else -> viewModel.toggleQuickTab(QuickTabKind.Everything, null, "Everything")
                  }
                },
              )

              // One of three levels, never a mixture.
              //
              //   searching       -> the results, wherever they live
              //   inside a model  -> its flavours, which is what gets rung up
              //   inside a brand  -> its models
              //   otherwise       -> the brands in this category
              //
              // A brand always opens on its model folders, even when it has
              // only one: the shop wants the same brand, model, flavor path
              // every time, so a cashier's hand learns one route and the
              // folder names the model the flavors on screen belong to.
              val openBrand = brands.firstOrNull { it.id == state.selectedBrandId }
              when {
                searching || state.selectedLineId != null ->
                  ProductGrid(
                    tiles = state.tiles,
                    parts = nav.parts,
                    insideLine = state.selectedLineId != null && !searching,
                    onTap = { viewModel.addToCart(it) },
                    modifier = Modifier.fillMaxSize(),
                    tileWidth = if (compact) 168.dp else Touch.TILE.dp,
                    pinnedIds = pinnedIds,
                    onHold = viewModel::togglePinnedProduct.takeIf { state.cashier != null },
                  )

                openBrand != null ->
                  LineFolderGrid(
                    lines = lines,
                    onOpen = { viewModel.selectLine(it.id) },
                    modifier = Modifier.fillMaxSize(),
                  )

                else ->
                  BrandFolderGrid(
                    brands = brands,
                    onOpen = { viewModel.selectBrand(it.id) },
                    modifier = Modifier.fillMaxSize(),
                  )
              }
            }

            IdleOverlay(
              visible = idle,
              storeName = state.storeName.ifBlank { "SnapPOS" },
              heldCount = state.heldCarts.size,
              onDismiss = { touches++ },
              modifier = Modifier.fillMaxSize(),
            )
          }

          VerticalLine()
          CartPanel(
            cart = state.cart,
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
            customerName = state.attachedCustomer?.displayName,
            onOpenCustomer = { showCustomer = true },
            modifier = Modifier.width(cartWidth).fillMaxHeight(),
          )
          VerticalLine()
          ActionRail(
            cartEmpty = state.cart.isEmpty,
            lineSelected = selectedLineId != null,
            onHold = { showHold = true },
            onDiscountLine = { showDiscount = true },
            onDiscountCart = { showCartDiscount = true },
            onOverride = { showOverridePrice = true },
            onClear = { confirmClear = true },
            onDetails = { showSaleDetails = true },
            modifier = Modifier.width(actionWidth).fillMaxHeight(),
          )
        }
      }
    }
  }

  if (state.showingReceipt) {
    state.lastReceipt?.let { receipt ->
      val printer = state.printerStatus
      ReceiptSheet(
        receipt = receipt,
        onDismiss = viewModel::dismissReceipt,
        // The shop's Star TSP100 takes 80 mm paper, so the preview is drawn
        // at the width the paper will actually be.
        width = PaperWidth.Mm80,
        onPrint = if (printer?.ready == true) viewModel::printReceipt else null,
        printing = state.printing,
        printNote = state.printProblem ?: printer?.detail,
        printNoteIsProblem = state.printProblem != null,
      )
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
      onCardPayment = {
        showPayment = false
        showCardPayment = true
      },
    )
  }

  if (showCardPayment) {
    CardPaymentDialog(
      total = state.cart.total,
      // Back to the payment choices, not out of the sale: a decline is followed
      // by cash or a split far more often than by walking away.
      onBack = {
        showCardPayment = false
        showPayment = true
      },
      onApproved = {
        showCardPayment = false
        viewModel.payCard()
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

  if (showSyncProblems) {
    SyncProblemsDialog(
      failed = failedUploads,
      onRetry = {
        viewModel.retryFailedUploads()
        showSyncProblems = false
      },
      onDismiss = { showSyncProblems = false },
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
      shape = RoundedCornerShape(Corner.PANEL.dp),
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

/** Does this pinned tab point at wherever the cashier is standing right now? */
private fun QuickTab.matches(state: RegisterUiState): Boolean = when (kind) {
  QuickTabKind.Line -> state.selectedLineId != null && target == state.selectedLineId
  QuickTabKind.Brand -> state.selectedLineId == null && target == state.selectedBrandId
  QuickTabKind.Category ->
    state.selectedLineId == null && state.selectedBrandId == null && target == state.selectedCategoryId
  QuickTabKind.Everything ->
    state.selectedLineId == null && state.selectedBrandId == null && state.selectedCategoryId == null
  // A product is never somewhere the cashier stands.
  QuickTabKind.Product -> false
}

enum class SyncState { Online, Syncing, Offline, Error }

@Composable
private fun RegisterHeader(
  cashier: String,
  storeName: String,
  state: SyncState,
  pending: Int,
  onSyncProblems: () -> Unit,
  onLock: () -> Unit,
  onCloseDrawer: () -> Unit,
  onRefund: () -> Unit,
  onReceipt: () -> Unit,
  hasReceipt: Boolean,
  heldCount: Int,
  onHeldSales: () -> Unit,
) {
  Column {
    Row(
      Modifier
        .fillMaxWidth()
        .background(MaterialTheme.colorScheme.surface)
        .padding(horizontal = Space.M.dp, vertical = Space.S.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      SnapPosMark(size = 34.dp)
      Spacer(Modifier.width(Space.S.dp + 2.dp))
      BrandLockup(caption = storeName)
      Spacer(Modifier.width(Space.L.dp))
      SyncPill(state, pending, onClick = onSyncProblems)
      Spacer(Modifier.weight(1f))

      Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
          .clip(RoundedCornerShape(999.dp))
          .background(MaterialTheme.colorScheme.surfaceVariant)
          .padding(horizontal = Space.S.dp + 2.dp, vertical = 6.dp),
      ) {
        Icon(
          Icons.Default.Person,
          null,
          tint = MaterialTheme.colorScheme.onSurfaceVariant,
          modifier = Modifier.size(15.dp),
        )
        Spacer(Modifier.width(6.dp))
        Text(cashier, style = MaterialTheme.typography.labelLarge)
      }
      Spacer(Modifier.width(Space.S.dp))

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
    // The only decoration on the screen, and it is the brand's own gradient.
    Box(Modifier.fillMaxWidth().height(2.dp).background(BrandHairline))
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
private fun SyncPill(state: SyncState, pending: Int, onClick: () -> Unit) {
  val (label, color) = when (state) {
    SyncState.Online -> "Online" to MaterialTheme.colorScheme.tertiary
    SyncState.Syncing -> "Syncing" to MaterialTheme.colorScheme.primary
    SyncState.Offline -> "$pending pending" to MaterialTheme.colorScheme.secondary
    SyncState.Error -> "Sync error" to MaterialTheme.colorScheme.error
  }
  Row(
    verticalAlignment = Alignment.CenterVertically,
    modifier = Modifier
      .clip(RoundedCornerShape(999.dp))
      // Red is the one state that needs a person, so it is the one that opens
      // something: what failed and why, and a way to send it again.
      .then(if (state == SyncState.Error) Modifier.clickable(onClick = onClick) else Modifier)
      .background(color.copy(alpha = 0.10f))
      .padding(horizontal = Space.S.dp + 2.dp, vertical = 6.dp),
  ) {
    Box(Modifier.size(7.dp).clip(CircleShape).background(color))
    Spacer(Modifier.width(Space.S.dp))
    Text(label, style = MaterialTheme.typography.labelMedium, color = color)
  }
}

/**
 * What is behind the red pill.
 *
 * Each upload the server refused for good, with the reason it gave. Before
 * this the pill said "Sync error" and nothing on the register could say why:
 * the only way to learn which sale failed, and whether it mattered, was to
 * read the device's log over a cable.
 */
@Composable
private fun SyncProblemsDialog(failed: List<FailedUpload>, onRetry: () -> Unit, onDismiss: () -> Unit) {
  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text("Not sent to the back office") },
    text = {
      Column {
        Text(
          "The server refused these. They are kept on this register, so nothing is lost. " +
            "Send them again once whatever stopped them is fixed.",
          style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(Space.M.dp))
        LazyColumn(Modifier.heightIn(max = 360.dp)) {
          items(failed.size) { index ->
            val item = failed[index]
            Column(Modifier.padding(vertical = Space.S.dp)) {
              Text(item.label, style = MaterialTheme.typography.titleSmall)
              Text(
                item.error,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
              )
            }
          }
        }
      }
    },
    confirmButton = {
      TextButton(onClick = onRetry, enabled = failed.isNotEmpty()) { Text("Send again") }
    },
    dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
  )
}

@Composable
private fun MessageBar(message: Toast, onDismiss: () -> Unit) {
  val foreground =
    if (message.isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.tertiary

  Row(
    Modifier
      .fillMaxWidth()
      .background(foreground.copy(alpha = 0.10f))
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

/**
 * Where you are, and the control that pins it.
 *
 * The pin lives here rather than in a settings screen because the moment a
 * cashier knows they want a shortcut is the moment they are standing on the
 * thing they want it to.
 */
@Composable
private fun Breadcrumb(
  categoryName: String?,
  brandName: String?,
  lineName: String?,
  count: Int,
  pinnable: Boolean,
  pinned: Boolean,
  onPin: () -> Unit,
) {
  val crumbs = listOfNotNull(categoryName ?: "Everything", brandName, lineName)
  Row(
    Modifier.fillMaxWidth().padding(horizontal = Space.M.dp, vertical = Space.XS.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    crumbs.forEachIndexed { index, crumb ->
      if (index > 0) {
        Icon(
          Icons.Default.ChevronRight,
          null,
          tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
          modifier = Modifier.size(15.dp),
        )
      }
      Text(
        crumb,
        style = MaterialTheme.typography.labelMedium,
        color = if (index == crumbs.lastIndex) MaterialTheme.colorScheme.onSurface
        else MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
    Spacer(Modifier.width(Space.S.dp))
    Text(
      "$count",
      style = MaterialTheme.typography.labelSmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.weight(1f))
    if (pinnable) {
      PinButton(pinned = pinned, label = crumbs.last(), onClick = onPin)
    }
  }
}

@Composable
private fun CartPanel(
  cart: Cart,
  busy: Boolean,
  onRemove: (String) -> Unit,
  onQuantity: (String, Int) -> Unit,
  onVerifyAge: () -> Unit,
  onPay: () -> Unit,
  selectedLineId: String?,
  onSelectLine: (String) -> Unit,
  customerName: String?,
  onOpenCustomer: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Column(modifier.background(MaterialTheme.colorScheme.surface)) {
    Column(Modifier.fillMaxWidth().padding(horizontal = Space.M.dp, vertical = Space.S.dp)) {
      Text("Current sale", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
      Text(
        "${customerName ?: "Walk-in customer"}  ·  ${cart.itemCount} ${if (cart.itemCount == 1) "item" else "items"}",
        style = MaterialTheme.typography.labelMedium,
        color = if (customerName != null) BrandRed else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.clickable(onClick = onOpenCustomer),
      )
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outline)

    LazyColumn(Modifier.weight(1f).heightIn(min = 88.dp)) {
      items(cart.effectiveLines, key = { it.id }) { line ->
        CartRow(
          line,
          selected = selectedLineId == line.id,
          onSelect = { onSelectLine(line.id) },
          onRemove = { onRemove(line.id) },
          onQuantity = { onQuantity(line.id, it) },
        )
      }
      if (cart.isEmpty) item { EmptyCart() }
    }

    HorizontalDivider(color = MaterialTheme.colorScheme.outline)

    if (cart.requiresAgeVerification) {
      AgeGate(cart.minimumAgeRequired ?: 21, onVerifyAge)
    }

    Column(Modifier.padding(Space.M.dp)) {
      TotalRow("Subtotal", cart.subtotal)
      if (!cart.discountTotal.isZero) TotalRow("Discount", -cart.discountTotal)
      TotalRow("Tax", cart.taxTotal)
      Spacer(Modifier.height(Space.S.dp))
      HorizontalDivider(color = MaterialTheme.colorScheme.outline)
      Spacer(Modifier.height(Space.S.dp))
      TotalRow("TOTAL", cart.total, emphasised = true)
      Spacer(Modifier.height(Space.M.dp))
      ChargeButton(cart = cart, busy = busy, onPay = onPay, onVerifyAge = onVerifyAge)
    }
  }
}

/**
 * CHARGE.
 *
 * The one control on the register painted in the shop's own gradient, because
 * it is the one moment in a sale that belongs to the shop. Everything else here
 * is grey on purpose so that this is unmissable from across the counter.
 */
@Composable
private fun ChargeButton(cart: Cart, busy: Boolean, onPay: () -> Unit, onVerifyAge: () -> Unit) {
  val gated = cart.requiresAgeVerification
  val enabled = !cart.isEmpty && !busy
  val fill: Brush = when {
    !enabled -> Brush.linearGradient(
      listOf(
        MaterialTheme.colorScheme.surfaceVariant,
        MaterialTheme.colorScheme.surfaceVariant,
      ),
    )
    gated -> Brush.linearGradient(listOf(MaterialTheme.colorScheme.secondary, Color(0xFFCE8A0B)))
    else -> BrandGradient
  }
  val label by animateColorAsState(
    if (enabled) Color.White else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
    tween(Motion.NORMAL, easing = Motion.Ease),
    label = "charge-label",
  )

  Box(
    Modifier
      .fillMaxWidth()
      .height(Touch.PRIMARY.dp)
      .clip(RoundedCornerShape(Corner.CONTROL.dp))
      .background(fill)
      .clickable(enabled = enabled, onClick = if (gated) onVerifyAge else onPay),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      if (gated) "VERIFY ${cart.minimumAgeRequired ?: 21}+ ID" else "CHARGE  $${cart.total.toMajorString()}",
      style = MaterialTheme.typography.headlineSmall.merge(MoneyTextStyle),
      fontWeight = FontWeight.Bold,
      color = label,
    )
  }
}

/**
 * The age gate.
 *
 * Blocks CHARGE rather than warning beside it. A prompt a cashier can tap past
 * during a rush is not a compliance control, it is a suggestion.
 */
@Composable
private fun AgeGate(minimumAge: Int, onVerify: () -> Unit) {
  Row(
    Modifier
      .fillMaxWidth()
      .background(MaterialTheme.colorScheme.secondaryContainer)
      .padding(horizontal = Space.M.dp, vertical = Space.S.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Column(Modifier.weight(1f)) {
      Text(
        "$minimumAge+ ID REQUIRED",
        style = MaterialTheme.typography.titleMedium,
        color = MaterialTheme.colorScheme.onSecondaryContainer,
      )
      Text(
        "Check the customer's ID before charging.",
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSecondaryContainer.copy(alpha = 0.8f),
      )
    }
    Button(
      onClick = onVerify,
      modifier = Modifier.height(Touch.MIN.dp),
      shape = RoundedCornerShape(Corner.CONTROL.dp),
      colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondary),
    ) { Text("ID CHECKED", fontWeight = FontWeight.Bold) }
  }
}

/**
 * One cart row.
 *
 * The description arrives as "Foger SwitchPro Disposable Pod | Mexico Mango" --
 * the same string the receipt will carry -- and is drawn with the model quiet
 * and the flavour bold. Every row in a vape sale shares the first five words,
 * so setting them all in the same weight makes a cart of six pods look like one
 * paragraph, and the cashier checking the screen against the counter has to
 * read to the end of every line to tell them apart.
 */
@Composable
private fun CartRow(
  line: CartLine,
  selected: Boolean,
  onSelect: () -> Unit,
  onRemove: () -> Unit,
  onQuantity: (Int) -> Unit,
) {
  Column(
    Modifier
      .fillMaxWidth()
      .background(if (selected) BrandOrange.copy(alpha = 0.08f) else MaterialTheme.colorScheme.surface)
      .clickable(onClick = onSelect)
      .padding(horizontal = Space.M.dp, vertical = Space.S.dp),
  ) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
      Text(
        splitDescription(line.description),
        style = MaterialTheme.typography.bodyMedium,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.weight(1f).padding(top = 6.dp),
      )
      TextButton(onClick = onRemove) {
        Text("×", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
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
      Text(line.total.toMajorString(), style = MaterialTheme.typography.titleMedium.merge(MoneyTextStyle))
    }
    line.minimumAge?.let { age ->
      Text(
        if (line.ageVerified) "$age+ verified" else "$age+ ID required",
        style = MaterialTheme.typography.labelSmall,
        color = if (line.ageVerified) MaterialTheme.colorScheme.tertiary
        else MaterialTheme.colorScheme.secondary,
      )
    }
  }
  HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.5f))
}

/** "Brand Model | Flavour" with the flavour carrying the weight. */
@Composable
private fun splitDescription(description: String): AnnotatedString {
  // Read outside the builder: its lambda is not a composable scope.
  val muted = MaterialTheme.colorScheme.onSurfaceVariant
  return remember(description, muted) {
    buildAnnotatedString {
      val pipe = description.indexOf('|')
      if (pipe <= 0) {
        withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(description) }
      } else {
        withStyle(SpanStyle(color = muted)) { append(description.take(pipe).trimEnd()) }
        append("  ")
        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(description.drop(pipe + 1).trim()) }
      }
    }
  }
}

@Composable
private fun QuantityButton(label: String, onClick: () -> Unit) {
  Box(
    Modifier
      .size(38.dp)
      .clip(RoundedCornerShape(10.dp))
      .background(MaterialTheme.colorScheme.surfaceVariant)
      .clickable(onClick = onClick),
    contentAlignment = Alignment.Center,
  ) {
    Text(label, style = MaterialTheme.typography.titleLarge)
  }
}

@Composable
private fun EmptyCart() {
  Column(
    Modifier.fillMaxWidth().padding(horizontal = Space.L.dp, vertical = Space.XL.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    SnapPosMark(size = 44.dp, modifier = Modifier.padding(bottom = Space.S.dp))
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
  Row(
    Modifier.fillMaxWidth().padding(vertical = 1.dp),
    horizontalArrangement = Arrangement.SpaceBetween,
  ) {
    Text(
      label,
      style = if (emphasised) MaterialTheme.typography.titleLarge else MaterialTheme.typography.bodyMedium,
      fontWeight = if (emphasised) FontWeight.Bold else FontWeight.Normal,
      color = if (emphasised) MaterialTheme.colorScheme.onSurface
      else MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Text(
      amount.toMajorString(),
      style = (if (emphasised) MaterialTheme.typography.titleLarge else MaterialTheme.typography.bodyMedium)
        .merge(MoneyTextStyle),
      fontWeight = if (emphasised) FontWeight.Bold else FontWeight.Medium,
    )
  }
}

@Composable
private fun VerticalLine() {
  Box(Modifier.width(1.dp).fillMaxHeight().background(MaterialTheme.colorScheme.outline))
}

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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
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

  var showPayment by remember { mutableStateOf(false) }

  val syncState = when {
    dead > 0 -> SyncState.Error
    pending > 0 -> SyncState.Offline
    else -> SyncState.Online
  }

  Surface(color = MaterialTheme.colorScheme.background) {
    Column(Modifier.fillMaxSize().safeDrawingPadding()) {
      RegisterHeader("Maria", "Register 1", syncState, pending)
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
            modifier = Modifier.width(if (compact) 280.dp else 340.dp).fillMaxHeight(),
          )
        }
      }
    }
  }

  if (showPayment) {
    CashPaymentDialog(
      total = state.cart.total,
      onDismiss = { showPayment = false },
      onConfirm = { tendered ->
        showPayment = false
        viewModel.payCash(tendered)
      },
    )
  }
}

enum class SyncState { Online, Syncing, Offline, Error }

/**
 * The scan field.
 *
 * Always focused, so a scan works the instant the app is open with no tap
 * required — a hardware scanner types like a keyboard and sends Enter, and if
 * nothing holds focus those characters go nowhere.
 *
 * The same field doubles as search, because a cashier looking something up and
 * a cashier scanning it are doing the same job and should not have to pick a
 * mode first.
 */
@Composable
private fun ScanField(onQueryChange: (String) -> Unit, onSubmit: (String) -> Unit) {
  val focus = remember { FocusRequester() }
  var text by remember { mutableStateOf("") }

  LaunchedEffect(Unit) { focus.requestFocus() }

  OutlinedTextField(
    value = text,
    onValueChange = {
      text = it
      onQueryChange(it)
    },
    modifier = Modifier
      .fillMaxWidth()
      .padding(horizontal = Space.M.dp, vertical = Space.S.dp)
      .focusRequester(focus),
    singleLine = true,
    placeholder = { Text("Scan or type SKU, UPC, name") },
    keyboardOptions = KeyboardOptions(
      keyboardType = KeyboardType.Ascii,
      imeAction = ImeAction.Done,
    ),
    keyboardActions = KeyboardActions(
      onDone = {
        // A scanner sends the barcode then Enter. Clearing here is what lets a
        // rapid sequence of scans work without the cashier touching anything.
        onSubmit(text)
        text = ""
        onQueryChange("")
        focus.requestFocus()
      },
    ),
  )
}

@Composable
private fun RegisterHeader(cashier: String, register: String, state: SyncState, pending: Int) {
  Row(
    Modifier
      .fillMaxWidth()
      .background(MaterialTheme.colorScheme.surface)
      .padding(horizontal = Space.M.dp, vertical = Space.S.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    SyncPill(state, pending)
    Spacer(Modifier.width(Space.M.dp))
    Text(
      "$register · $cashier",
      style = MaterialTheme.typography.bodyMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
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
  LazyColumn(modifier.padding(Space.S.dp)) {
    item { SectionLabel("CATEGORIES") }
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
      .clip(RoundedCornerShape(6.dp))
      .background(
        if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)
        else MaterialTheme.colorScheme.background,
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
      .height(Touch.TILE.dp)
      .clip(RoundedCornerShape(12.dp))
      .background(MaterialTheme.colorScheme.surface)
      .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(12.dp))
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
        tile.price?.toMajorString() ?: "—",
        style = MaterialTheme.typography.bodyLarge.merge(MoneyTextStyle),
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
  modifier: Modifier = Modifier,
) {
  Column(modifier.background(MaterialTheme.colorScheme.surface)) {
    Row(
      Modifier.fillMaxWidth().padding(Space.M.dp),
      horizontalArrangement = Arrangement.SpaceBetween,
    ) {
      Text(
        "CART",
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      Text(
        "${cart.itemCount} items",
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outline)

    LazyColumn(Modifier.weight(1f).heightIn(min = 88.dp)) {
      items(cart.effectiveLines, key = { it.id }) { line ->
        CartRow(line, onRemove = { onRemove(line.id) }, onQuantity = { onQuantity(line.id, it) })
      }
    }

    HorizontalDivider(color = MaterialTheme.colorScheme.outline)

    if (cart.requiresAgeVerification) {
      AgeGate(cart.minimumAgeRequired ?: 21, onVerifyAge)
    }

    Column(Modifier.padding(if (compact) Space.S.dp else Space.M.dp)) {
      TotalRow("Subtotal", cart.subtotal)
      if (!cart.discountTotal.isZero) TotalRow("Discount", -cart.discountTotal)
      TotalRow("Tax", cart.taxTotal)
      Spacer(Modifier.height(Space.S.dp))
      TotalRow("TOTAL", cart.total, emphasised = true)
      Spacer(Modifier.height(if (compact) Space.S.dp else Space.M.dp))
      Button(
        onClick = onPay,
        enabled = !cart.isEmpty && !busy && !cart.requiresAgeVerification,
        // Never below the 56dp minimum even when squeezed: PAY is the most
        // pressed control in the building.
        modifier = Modifier
          .fillMaxWidth()
          .height(if (compact) Touch.MIN.dp else Touch.PRIMARY.dp),
        shape = RoundedCornerShape(6.dp),
        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary),
      ) {
        Text("PAY", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
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
private fun AgeGate(minimumAge: Int, onVerify: () -> Unit) {
  Column(
    Modifier
      .fillMaxWidth()
      .background(MaterialTheme.colorScheme.secondary.copy(alpha = 0.15f))
      .padding(Space.M.dp),
  ) {
    Text(
      "$minimumAge+ ID REQUIRED",
      style = MaterialTheme.typography.titleLarge,
      color = MaterialTheme.colorScheme.secondary,
    )
    Spacer(Modifier.height(Space.S.dp))
    Button(
      onClick = onVerify,
      modifier = Modifier.fillMaxWidth().height(Touch.MIN.dp),
      shape = RoundedCornerShape(6.dp),
      colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondary),
    ) {
      Text("ID CHECKED", fontWeight = FontWeight.SemiBold)
    }
  }
}

@Composable
private fun CartRow(line: CartLine, onRemove: () -> Unit, onQuantity: (Int) -> Unit) {
  Column(Modifier.fillMaxWidth().padding(horizontal = Space.M.dp, vertical = Space.S.dp)) {
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

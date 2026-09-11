package com.snappos.pos.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.snappos.domain.Money
import com.snappos.domain.applyRate

/**
 * The register, laid out as architecture section O specifies:
 * favourites on the left, products in the centre, cart on the right.
 *
 * This is the shell. It renders the layout and the design tokens against static
 * data so the visual decisions can be reviewed on a real device before the
 * scan, cart and payment machinery is wired behind it.
 *
 * Two rules that are already load bearing and easy to erode later:
 *
 *  - **Zero animation on the scan-to-cart path.** A row that animates in is a
 *    row the cashier waits for. The budget is 120ms from HID input to rendered
 *    row, and animation spends it.
 *  - **Tabular numerals on every money figure.** Columns of prices must align
 *    and a changing total must not shimmer.
 */

data class CartLine(
  val description: String,
  val variantName: String?,
  val quantity: Int,
  val unitPrice: Money,
  val ageRestricted: Boolean = false,
  val verified: Boolean = false,
) {
  val total: Money get() = unitPrice * quantity
}

data class ProductTile(
  val name: String,
  val variantName: String?,
  val price: Money,
  val inStock: Boolean = true,
)

@Composable
fun RegisterScreen(
  cashierName: String = "Maria",
  registerName: String = "Register 1",
  syncState: SyncState = SyncState.Online,
  categories: List<String> = DEMO_CATEGORIES,
  tiles: List<ProductTile> = DEMO_TILES,
  cart: List<CartLine> = DEMO_CART,
) {
  Surface(color = MaterialTheme.colorScheme.background) {
    Column(Modifier.fillMaxSize()) {
      RegisterHeader(cashierName, registerName, syncState)
      HorizontalDivider(color = MaterialTheme.colorScheme.outline)

      Row(Modifier.fillMaxSize()) {
        CategoryRail(categories, Modifier.width(160.dp).fillMaxHeight())
        VerticalLine()
        ProductGrid(tiles, Modifier.weight(1f).fillMaxHeight())
        VerticalLine()
        CartPanel(cart, Modifier.width(340.dp).fillMaxHeight())
      }
    }
  }
}

enum class SyncState { Online, Syncing, Offline, Error }

@Composable
private fun RegisterHeader(cashier: String, register: String, state: SyncState) {
  Row(
    Modifier
      .fillMaxWidth()
      .background(MaterialTheme.colorScheme.surface)
      .padding(horizontal = Space.M.dp, vertical = Space.S.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    SyncPill(state)
    Spacer(Modifier.width(Space.M.dp))
    Text(
      "$register · $cashier",
      style = MaterialTheme.typography.bodyMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.weight(1f))
    Text(
      "14:32",
      style = MaterialTheme.typography.bodyMedium.merge(MoneyTextStyle),
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
  }
}

/**
 * The sync pill, always visible.
 *
 * Offline is amber, deliberately not red. Offline is a normal, safe operating
 * mode - the sale is being saved on this device - and the interface must not
 * communicate panic about it. Red is reserved for a sync error, which is the
 * only state that actually needs a person.
 */
@Composable
private fun SyncPill(state: SyncState) {
  val (label, color) = when (state) {
    SyncState.Online -> "Online" to MaterialTheme.colorScheme.tertiary
    SyncState.Syncing -> "Syncing" to MaterialTheme.colorScheme.primary
    SyncState.Offline -> "Offline" to MaterialTheme.colorScheme.secondary
    SyncState.Error -> "Sync Error" to MaterialTheme.colorScheme.error
  }
  Row(verticalAlignment = Alignment.CenterVertically) {
    Box(Modifier.size(8.dp).clip(CircleShape).background(color))
    Spacer(Modifier.width(Space.S.dp))
    Text(label, style = MaterialTheme.typography.labelMedium, color = color)
  }
}

@Composable
private fun CategoryRail(categories: List<String>, modifier: Modifier = Modifier) {
  Column(modifier.padding(Space.S.dp)) {
    SectionLabel("FAVORITES")
    categories.forEach { category ->
      Box(
        Modifier
          .fillMaxWidth()
          .height(Touch.MIN.dp)
          .clip(RoundedCornerShape(6.dp))
          .clickable { }
          .padding(horizontal = Space.M.dp),
        contentAlignment = Alignment.CenterStart,
      ) {
        Text(category, style = MaterialTheme.typography.bodyLarge)
      }
    }
  }
}

@Composable
private fun ProductGrid(tiles: List<ProductTile>, modifier: Modifier = Modifier) {
  LazyVerticalGrid(
    columns = GridCells.Adaptive(minSize = Touch.TILE.dp),
    modifier = modifier.padding(Space.M.dp),
    horizontalArrangement = Arrangement.spacedBy(Space.S.dp),
    verticalArrangement = Arrangement.spacedBy(Space.S.dp),
  ) {
    items(tiles.size) { index -> ProductTileCard(tiles[index]) }
  }
}

@Composable
private fun ProductTileCard(tile: ProductTile) {
  Column(
    Modifier
      .aspectRatio(1f)
      .clip(RoundedCornerShape(12.dp))
      .background(MaterialTheme.colorScheme.surface)
      .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(12.dp))
      .clickable { }
      .padding(Space.S.dp),
    verticalArrangement = Arrangement.SpaceBetween,
  ) {
    Column {
      Text(
        tile.name,
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
    Row(verticalAlignment = Alignment.CenterVertically) {
      Text(tile.price.toMajorString(), style = MaterialTheme.typography.bodyLarge.merge(MoneyTextStyle))
      if (!tile.inStock) {
        Spacer(Modifier.width(Space.XS.dp))
        Text(
          "0",
          style = MaterialTheme.typography.labelMedium,
          color = MaterialTheme.colorScheme.error,
        )
      }
    }
  }
}

@Composable
private fun CartPanel(cart: List<CartLine>, modifier: Modifier = Modifier) {
  val subtotal = Money.sum(cart.map { it.total })
  val tax = subtotal.applyRate("0.0825")
  val total = subtotal + tax

  Column(modifier.background(MaterialTheme.colorScheme.surface)) {
    Row(
      Modifier.fillMaxWidth().padding(Space.M.dp),
      horizontalArrangement = Arrangement.SpaceBetween,
    ) {
      Text("CART", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
      Text(
        "${cart.sumOf { it.quantity }} items",
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outline)

    LazyColumn(Modifier.weight(1f)) {
      items(cart) { line -> CartRow(line) }
    }

    HorizontalDivider(color = MaterialTheme.colorScheme.outline)
    Column(Modifier.padding(Space.M.dp)) {
      TotalRow("Subtotal", subtotal)
      TotalRow("Tax", tax)
      Spacer(Modifier.height(Space.S.dp))
      TotalRow("TOTAL", total, emphasised = true)
      Spacer(Modifier.height(Space.M.dp))
      Button(
        onClick = { },
        modifier = Modifier.fillMaxWidth().height(Touch.PRIMARY.dp),
        shape = RoundedCornerShape(6.dp),
        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary),
      ) {
        Text("PAY", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
      }
    }
  }
}

@Composable
private fun CartRow(line: CartLine) {
  Column(Modifier.fillMaxWidth().padding(horizontal = Space.M.dp, vertical = Space.S.dp)) {
    Text(line.description, style = MaterialTheme.typography.bodyLarge)
    line.variantName?.let {
      Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
      Text(
        "${line.quantity} × ${line.unitPrice.toMajorString()}",
        style = MaterialTheme.typography.bodyMedium.merge(MoneyTextStyle),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      Text(line.total.toMajorString(), style = MaterialTheme.typography.bodyLarge.merge(MoneyTextStyle))
    }
    if (line.ageRestricted) {
      Text(
        if (line.verified) "21+ verified" else "21+ ID REQUIRED",
        style = MaterialTheme.typography.labelMedium,
        color = if (line.verified) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.secondary,
      )
    }
  }
}

@Composable
private fun TotalRow(label: String, amount: Money, emphasised: Boolean = false) {
  Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
    Text(
      label,
      style = if (emphasised) MaterialTheme.typography.titleLarge else MaterialTheme.typography.bodyMedium,
      color = if (emphasised) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
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

private val DEMO_CATEGORIES =
  listOf("Vapes", "Tobacco", "Glass", "Hemp", "Drinks", "Snacks", "Accessories")

private val DEMO_TILES = listOf(
  ProductTile("Geek Bar Pulse X", "Miami Mint", Money.fromMajor("24.99")),
  ProductTile("Geek Bar Pulse X", "Blue Razz Ice", Money.fromMajor("24.99")),
  ProductTile("Geek Bar Pulse X", "Watermelon Ice", Money.fromMajor("24.99"), inStock = false),
  ProductTile("Lost Mary BM6000", "Blueberry Ice", Money.fromMajor("19.99")),
  ProductTile("Backwoods 5pk", "Honey Berry", Money.fromMajor("6.49")),
  ProductTile("Zyn Pouches", "Cool Mint 6mg", Money.fromMajor("5.99")),
  ProductTile("Monster Ultra", null, Money.fromMajor("3.99")),
  ProductTile("RAW King Size", null, Money.fromMajor("2.99")),
)

private val DEMO_CART = listOf(
  CartLine("Geek Bar Pulse X", "Miami Mint", 2, Money.fromMajor("24.99"), ageRestricted = true, verified = true),
  CartLine("Backwoods 5pk", "Honey Berry", 1, Money.fromMajor("6.49"), ageRestricted = true, verified = true),
  CartLine("Monster Ultra", null, 1, Money.fromMajor("3.99")),
)

@Preview(widthDp = 1280, heightDp = 800)
@Composable
private fun RegisterPreview() {
  SnapPosTheme { RegisterScreen() }
}

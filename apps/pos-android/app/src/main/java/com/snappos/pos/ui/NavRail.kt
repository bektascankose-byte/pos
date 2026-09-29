package com.snappos.pos.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DragIndicator
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import coil.compose.AsyncImage
import com.snappos.data.QuickTab
import com.snappos.data.QuickTabKind
import com.snappos.data.ResolvedProduct
import com.snappos.domain.ProductNameParts
import com.snappos.pos.productImageUrl

/**
 * The left rail: where a cashier's hand goes first.
 *
 * Two lists, and the order of them is the point. **Quick** is on top and holds
 * whatever this cashier pinned; **Browse** is underneath and holds the shop's
 * categories. The old rail led with "All", which dumped every product in the
 * building into one grid and made the first thing a cashier saw the least
 * useful screen the register can draw. All is still reachable, at the bottom of
 * Browse, where a thing you need twice a week belongs.
 *
 * Quick holds products now, not only places. A pinned product is a key on the
 * till: one tap rings it up from wherever the cashier is standing, without
 * opening anything. Holding a row and dragging it reorders the menu, and Edit
 * shows the X that takes a row off.
 */
@Composable
fun NavRail(
  quickTabs: List<QuickTab>,
  pinnedProducts: Map<String, ResolvedProduct>,
  parts: Map<String, ProductNameParts>,
  categories: List<CategoryTile>,
  selectedCategoryId: String?,
  hasSelection: Boolean,
  onQuickTab: (QuickTab) -> Unit,
  onReorderQuick: (List<String>) -> Unit,
  onRemoveQuick: (QuickTab) -> Unit,
  onCategory: (String?) -> Unit,
  modifier: Modifier = Modifier,
) {
  var editing by remember { mutableStateOf(false) }
  LaunchedEffect(quickTabs.isEmpty()) { if (quickTabs.isEmpty()) editing = false }

  LazyColumn(
    modifier
      .background(MaterialTheme.colorScheme.surface)
      .padding(horizontal = Space.S.dp, vertical = Space.S.dp),
    verticalArrangement = Arrangement.spacedBy(2.dp),
  ) {
    item {
      RailHeading("QUICK", Icons.Default.Bolt) {
        if (quickTabs.isNotEmpty()) {
          Text(
            if (editing) "Done" else "Edit",
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            color = BrandOrange,
            modifier = Modifier
              .clip(RoundedCornerShape(Corner.CHIP.dp))
              .clickable { editing = !editing }
              .padding(horizontal = Space.S.dp, vertical = Space.S.dp),
          )
        }
      }
    }
    // Said where the thing will appear, because a hold is a gesture nobody
    // discovers by looking at a tile.
    val hint = when {
      quickTabs.isEmpty() -> "Hold any product to pin it here."
      editing -> "Hold a row and drag it to reorder. X takes it off."
      else -> null
    }
    hint?.let { item { RailHint(it) } }
    if (quickTabs.isNotEmpty()) {
      item(key = "quick") {
        QuickList(
          tabs = quickTabs,
          pinnedProducts = pinnedProducts,
          parts = parts,
          editing = editing,
          onTap = onQuickTab,
          onRemove = onRemoveQuick,
          onReorder = onReorderQuick,
        )
      }
    }
    item { Spacer(Modifier.height(Space.M.dp)) }

    item { RailHeading("BROWSE", Icons.Default.Apps) }
    items(categories, key = { it.id }) { category ->
      RailRow(
        label = category.name,
        selected = selectedCategoryId == category.id && !hasSelection,
        onClick = { onCategory(category.id) },
      )
    }
    item {
      RailRow(
        label = "Everything",
        selected = selectedCategoryId == null && !hasSelection,
        muted = true,
        onClick = { onCategory(null) },
      )
    }
  }
}

/** Every quick row is this tall, which is what lets a drag work out where it is by arithmetic alone. */
private const val QUICK_ROW = Touch.MIN
private const val QUICK_GAP = 2

/**
 * The cashier's quick menu, in their order, reorderable by holding a row.
 *
 * Hold, not grab: a row is a key the cashier taps all shift, and a list that
 * moved under an ordinary tap would be one they could not trust. After the
 * hold the row lifts, follows the finger, and the others step out of its way
 * one row at a time; letting go saves the order.
 *
 * Every row is the same height, so the row the finger is over is the drag
 * distance divided by the row pitch. No measuring, and nothing to go wrong
 * when a photo loads late and a row would otherwise change size mid-drag.
 */
@Composable
private fun QuickList(
  tabs: List<QuickTab>,
  pinnedProducts: Map<String, ResolvedProduct>,
  parts: Map<String, ProductNameParts>,
  editing: Boolean,
  onTap: (QuickTab) -> Unit,
  onRemove: (QuickTab) -> Unit,
  onReorder: (List<String>) -> Unit,
) {
  val haptics = LocalHapticFeedback.current
  val pitch = with(LocalDensity.current) { (QUICK_ROW + QUICK_GAP).dp.toPx() }

  // The order while a drag is under way, and just after, until the saved
  // order comes back from storage. Without the second half the list would
  // snap back to the old order for the frame or two the save takes.
  var local by remember { mutableStateOf<List<QuickTab>?>(null) }
  var dragging by remember { mutableStateOf<String?>(null) }
  var offset by remember { mutableFloatStateOf(0f) }
  LaunchedEffect(tabs) { if (dragging == null) local = null }

  val shown = local?.takeIf { held ->
    dragging != null || held.map { it.key }.toSet() == tabs.map { it.key }.toSet()
  } ?: tabs
  val current by rememberUpdatedState(shown)
  val save by rememberUpdatedState(onReorder)

  fun drop() {
    val order = local
    dragging = null
    offset = 0f
    if (order != null) save(order.map { it.key })
  }

  Column(verticalArrangement = Arrangement.spacedBy(QUICK_GAP.dp)) {
    shown.forEach { tab ->
      key(tab.key) {
        val lifted = dragging == tab.key
        QuickRow(
          tab = tab,
          product = tab.target?.let(pinnedProducts::get),
          parts = tab.target?.let(parts::get),
          catalogReady = parts.isNotEmpty(),
          editing = editing,
          lifted = lifted,
          onRemove = { onRemove(tab) },
          modifier = Modifier
            .zIndex(if (lifted) 1f else 0f)
            .graphicsLayer {
              translationY = if (lifted) offset else 0f
              val scale = if (lifted) 1.04f else 1f
              scaleX = scale
              scaleY = scale
            },
          // Tap outermost, drag innermost: the drag sees the finger first,
          // and once it has lifted the row it consumes the release, so letting
          // go after a drag never also rings the item up.
          gestures = Modifier
            .clickable(enabled = !editing) { onTap(tab) }
            .pointerInput(tab.key) {
              detectDragGesturesAfterLongPress(
                onDragStart = {
                  haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                  local = current
                  dragging = tab.key
                  offset = 0f
                },
                onDrag = { change, amount ->
                  change.consume()
                  offset += amount.y
                  val list = local ?: return@detectDragGesturesAfterLongPress
                  val from = list.indexOfFirst { it.key == dragging }
                  if (from < 0) return@detectDragGesturesAfterLongPress
                  // Half a row past a neighbour and the two trade places. The
                  // offset gives back the row it just moved, so the lifted row
                  // stays under the finger instead of jumping a row ahead.
                  if (offset > pitch / 2 && from < list.lastIndex) {
                    local = list.moved(from, from + 1)
                    offset -= pitch
                  } else if (offset < -pitch / 2 && from > 0) {
                    local = list.moved(from, from - 1)
                    offset += pitch
                  }
                },
                onDragEnd = { drop() },
                onDragCancel = { drop() },
              )
            },
        )
      }
    }
  }
}

private fun <T> List<T>.moved(from: Int, to: Int): List<T> =
  toMutableList().also { it.add(to, it.removeAt(from)) }

/**
 * One entry in the quick menu.
 *
 * A product shows its photograph and its flavour, with the model underneath:
 * "Blue Razz Ice" over "SwitchPro KIt 30K". The flavour leads because it is
 * the word that differs between two pins of the same line; the model is there
 * because the pod and the kit both come in Blue Razz Ice.
 */
@Composable
private fun QuickRow(
  tab: QuickTab,
  product: ResolvedProduct?,
  parts: ProductNameParts?,
  catalogReady: Boolean,
  editing: Boolean,
  lifted: Boolean,
  onRemove: () -> Unit,
  modifier: Modifier,
  gestures: Modifier,
) {
  val shape = RoundedCornerShape(Corner.CHIP.dp)
  val gone = tab.kind == QuickTabKind.Product && catalogReady && parts == null
  Row(
    modifier
      .fillMaxWidth()
      .height(QUICK_ROW.dp)
      .clip(shape)
      .background(if (lifted) MaterialTheme.colorScheme.surface else Color.Transparent)
      .border(1.dp, if (lifted) BrandOrange.copy(alpha = 0.55f) else Color.Transparent, shape)
      .then(gestures)
      .padding(horizontal = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      Modifier
        .size(40.dp)
        .clip(RoundedCornerShape(8.dp))
        .background(
          if (tab.kind == QuickTabKind.Product) MaterialTheme.colorScheme.surfaceVariant
          else BrandOrange.copy(alpha = 0.10f),
        ),
      contentAlignment = Alignment.Center,
    ) {
      val image = product?.imageUrl
      when {
        tab.kind != QuickTabKind.Product -> Icon(
          if (tab.kind == QuickTabKind.Everything) Icons.Default.Apps else Icons.Default.Folder,
          contentDescription = null,
          tint = BrandOrange,
          modifier = Modifier.size(20.dp),
        )
        image != null -> AsyncImage(
          model = productImageUrl(image),
          contentDescription = null,
          contentScale = ContentScale.Fit,
          modifier = Modifier.size(40.dp).padding(2.dp),
        )
        else -> Text(
          (parts?.tileLabel ?: tab.label).take(1).uppercase(),
          style = MaterialTheme.typography.titleMedium,
          fontWeight = FontWeight.Bold,
          color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.45f),
        )
      }
    }
    Spacer(Modifier.width(Space.S.dp))
    Column(Modifier.weight(1f)) {
      val title = if (tab.kind == QuickTabKind.Product) parts?.tileLabel ?: tab.label else tab.label
      val subtitle = when {
        tab.kind != QuickTabKind.Product -> null
        gone -> "No longer in the catalog"
        // The model alone: the photo already says which brand, and in a rail
        // this narrow "Foger SwitchPro Dis..." cut off exactly the word that
        // tells the pod from the kit.
        else -> parts?.line?.takeIf { it.isNotBlank() } ?: parts?.brand
      }
      Text(
        title,
        style = MaterialTheme.typography.bodyMedium,
        fontWeight = FontWeight.SemiBold,
        color = if (gone) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
        maxLines = if (subtitle == null) 2 else 1,
        overflow = TextOverflow.Ellipsis,
      )
      subtitle?.let {
        Text(
          it,
          style = MaterialTheme.typography.labelSmall,
          color = if (gone) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
    }
    when {
      editing -> IconButton(onClick = onRemove, modifier = Modifier.size(40.dp)) {
        Icon(Icons.Default.Close, contentDescription = "Take off quick menu", tint = MaterialTheme.colorScheme.onSurfaceVariant)
      }
      lifted -> Icon(
        Icons.Default.DragIndicator,
        contentDescription = null,
        tint = BrandOrange,
        modifier = Modifier.size(20.dp),
      )
    }
  }
}

@Composable
private fun RailHint(text: String) {
  Text(
    text,
    style = MaterialTheme.typography.labelSmall,
    color = MaterialTheme.colorScheme.onSurfaceVariant,
    modifier = Modifier.padding(start = Space.S.dp, end = Space.S.dp, bottom = Space.XS.dp),
  )
}

/**
 * The pin.
 *
 * Deliberately one control that both pins and unpins, sitting in the header of
 * wherever the cashier already is. A separate settings screen for this would be
 * a screen nobody opens: the moment a person knows they want a shortcut is the
 * moment they are standing on the thing they want it to.
 */
@Composable
fun PinButton(pinned: Boolean, label: String, onClick: () -> Unit) {
  val tint by animateColorAsState(
    if (pinned) BrandOrange else MaterialTheme.colorScheme.onSurfaceVariant,
    tween(Motion.FAST, easing = Motion.Ease),
    label = "pin",
  )
  Row(
    Modifier
      .clip(RoundedCornerShape(Corner.CHIP.dp))
      .background(if (pinned) BrandOrange.copy(alpha = 0.10f) else Color.Transparent)
      .clickable(onClick = onClick)
      .padding(horizontal = Space.S.dp, vertical = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(Icons.Default.PushPin, null, tint = tint, modifier = Modifier.size(16.dp))
    Spacer(Modifier.width(6.dp))
    Text(
      if (pinned) "Pinned" else "Pin $label",
      style = MaterialTheme.typography.labelMedium,
      color = tint,
      maxLines = 1,
    )
  }
}

@Composable
private fun RailHeading(
  text: String,
  icon: androidx.compose.ui.graphics.vector.ImageVector,
  trailing: @Composable () -> Unit = {},
) {
  Row(
    Modifier.fillMaxWidth().padding(start = Space.S.dp, top = Space.XS.dp, bottom = Space.XS.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(
      icon,
      null,
      tint = MaterialTheme.colorScheme.onSurfaceVariant,
      modifier = Modifier.size(14.dp),
    )
    Spacer(Modifier.width(6.dp))
    Text(
      text,
      style = MaterialTheme.typography.labelSmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      modifier = Modifier.padding(vertical = Space.S.dp),
    )
    Spacer(Modifier.weight(1f))
    trailing()
  }
}

/**
 * One row of the rail.
 *
 * The selected state is carried by a bar down the left edge that grows into
 * place rather than by a colour swap. On a till that is glanced at rather than
 * read, an edge that moves is legible from a metre away and a tint change is
 * not.
 */
@Composable
private fun RailRow(
  label: String,
  selected: Boolean,
  accent: Boolean = false,
  muted: Boolean = false,
  onClick: () -> Unit,
) {
  val markerHeight by animateDpAsState(
    if (selected) 24.dp else 0.dp,
    tween(Motion.NORMAL, easing = Motion.EaseOut),
    label = "rail-marker",
  )
  val background by animateColorAsState(
    when {
      selected -> BrandOrange.copy(alpha = 0.10f)
      else -> Color.Transparent
    },
    tween(Motion.NORMAL, easing = Motion.Ease),
    label = "rail-bg",
  )

  Row(
    Modifier
      .fillMaxWidth()
      .height(Touch.MIN.dp)
      .clip(RoundedCornerShape(Corner.CHIP.dp))
      .background(background)
      .clickable(onClick = onClick),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      Modifier
        .padding(start = 4.dp)
        .width(3.dp)
        .height(markerHeight)
        .clip(RoundedCornerShape(2.dp))
        .background(BrandGradient),
    )
    Text(
      label,
      style = MaterialTheme.typography.bodyLarge,
      fontWeight = if (selected || accent) FontWeight.SemiBold else FontWeight.Normal,
      color = when {
        selected -> BrandRed
        accent -> MaterialTheme.colorScheme.onSurface
        muted -> MaterialTheme.colorScheme.onSurfaceVariant
        else -> MaterialTheme.colorScheme.onSurface
      },
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.padding(start = if (selected) Space.S.dp else 11.dp, end = Space.S.dp),
    )
  }
}

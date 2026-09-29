package com.snappos.pos.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.snappos.data.QuickTab
import com.snappos.data.QuickTabKind

/**
 * The left rail: where a cashier's hand goes first.
 *
 * Two lists, and the order of them is the point. **Quick** is on top and holds
 * whatever this cashier pinned; **Browse** is underneath and holds the shop's
 * categories. The old rail led with "All", which dumped every product in the
 * building into one grid and made the first thing a cashier saw the least
 * useful screen the register can draw. All is still reachable, at the bottom of
 * Browse, where a thing you need twice a week belongs.
 */
@Composable
fun NavRail(
  quickTabs: List<QuickTab>,
  categories: List<CategoryTile>,
  selectedCategoryId: String?,
  hasSelection: Boolean,
  onQuickTab: (QuickTab) -> Unit,
  onCategory: (String?) -> Unit,
  modifier: Modifier = Modifier,
) {
  LazyColumn(
    modifier
      .background(MaterialTheme.colorScheme.surface)
      .padding(horizontal = Space.S.dp, vertical = Space.S.dp),
    verticalArrangement = Arrangement.spacedBy(2.dp),
  ) {
    if (quickTabs.isNotEmpty()) {
      item { RailHeading("QUICK", Icons.Default.Bolt) }
      items(quickTabs, key = { "${it.kind}:${it.target}" }) { tab ->
        RailRow(
          label = tab.label,
          selected = false,
          accent = true,
          onClick = { onQuickTab(tab) },
        )
      }
      item { Spacer(Modifier.height(Space.M.dp)) }
    }

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
private fun RailHeading(text: String, icon: androidx.compose.ui.graphics.vector.ImageVector) {
  Row(
    Modifier.fillMaxWidth().padding(horizontal = Space.S.dp, vertical = Space.S.dp),
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
    )
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

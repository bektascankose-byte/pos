package com.snappos.pos.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AttachMoney
import androidx.compose.material.icons.filled.LocalOffer
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PauseCircle
import androidx.compose.material.icons.filled.Percent
import androidx.compose.material.icons.filled.RestartAlt
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * The sale actions, down the right edge.
 *
 * They used to sit in a row inside the cart panel, six of them sharing 340dp
 * with an icon and a label each. That is 56dp per button, which fits the icon
 * and roughly one character, so the till shipped a row reading "H", "D", "C",
 * "C", "C", "D" and a cashier had to learn the order by position. Nothing was
 * broken; it simply could not be read.
 *
 * Vertical is the fix, and it is not a compromise. A column has as much room as
 * the screen is tall, so every action gets its whole word, and the row of
 * actions no longer competes with the cart for width -- which is what the cart,
 * the one thing on this screen the customer also cares about, wanted all along.
 */
@Composable
fun ActionRail(
  cartEmpty: Boolean,
  lineSelected: Boolean,
  onHold: () -> Unit,
  onDiscountLine: () -> Unit,
  onDiscountCart: () -> Unit,
  onOverride: () -> Unit,
  onClear: () -> Unit,
  onDetails: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Column(
    modifier
      .background(MaterialTheme.colorScheme.surface)
      .padding(horizontal = Space.S.dp, vertical = Space.S.dp),
    verticalArrangement = Arrangement.spacedBy(Space.XS.dp),
  ) {
    RailAction("Hold", Icons.Default.PauseCircle, enabled = !cartEmpty, onClick = onHold)
    RailAction("Discount", Icons.Default.Percent, enabled = lineSelected, onClick = onDiscountLine)
    RailAction("Sale off", Icons.Default.LocalOffer, enabled = !cartEmpty, onClick = onDiscountCart)
    RailAction("Override", Icons.Default.AttachMoney, enabled = lineSelected, onClick = onOverride)
    Spacer(Modifier.height(Space.S.dp))
    RailAction("Clear", Icons.Default.RestartAlt, enabled = !cartEmpty, destructive = true, onClick = onClear)
    RailAction("Details", Icons.Default.MoreVert, enabled = true, onClick = onDetails)
  }
}

/**
 * One action.
 *
 * Disabled is drawn as faded rather than hidden, on purpose. A till whose
 * controls come and go depending on what is selected teaches a cashier that
 * buttons move, and then they hunt for one every time. A greyed "Override" in
 * the place it always sits says "select a line first" without a word.
 */
@Composable
private fun RailAction(
  label: String,
  icon: ImageVector,
  enabled: Boolean,
  destructive: Boolean = false,
  onClick: () -> Unit,
) {
  val content by animateColorAsState(
    when {
      !enabled -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.35f)
      destructive -> MaterialTheme.colorScheme.error
      else -> MaterialTheme.colorScheme.onSurface
    },
    tween(Motion.NORMAL, easing = Motion.Ease),
    label = "action-tint",
  )

  Column(
    Modifier
      .fillMaxWidth()
      .height(Touch.MIN.dp + 8.dp)
      .clip(RoundedCornerShape(Corner.CHIP.dp))
      .background(
        if (enabled) MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f)
        else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.22f),
      )
      .clickable(enabled = enabled, onClick = onClick)
      .padding(horizontal = 2.dp, vertical = Space.S.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center,
  ) {
    Icon(icon, null, tint = content, modifier = Modifier.size(20.dp))
    Spacer(Modifier.height(2.dp))
    Text(
      label,
      style = MaterialTheme.typography.labelMedium,
      color = content,
      maxLines = 1,
      textAlign = TextAlign.Center,
    )
  }
}

package com.snappos.pos.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Backspace
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.snappos.domain.Cart
import com.snappos.domain.Money

/**
 * What the customer sees.
 *
 * Written for someone standing a metre away who is not looking at it
 * continuously: three or four things, all large, and the total is the largest
 * thing on the screen by a wide margin. This is the screen a customer checks a
 * price against, so it shows the same line text as the receipt they are about
 * to be handed -- "Foger SwitchPro Disposable Pod | Mexico Mango" -- rather
 * than a shortened version they would then have to reconcile.
 */
@Composable
fun CustomerScreen(
  state: CustomerScreenState,
  onPhoneEntered: (String) -> Unit,
  onDismiss: () -> Unit,
) {
  Row(
    Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background),
  ) {
    Column(Modifier.weight(1.35f).fillMaxHeight().padding(Space.L.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        SnapPosMark(size = 40.dp)
        Spacer(Modifier.width(Space.M.dp))
        Column {
          Text(
            state.storeName.ifBlank { "SnapPOS" },
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
          )
          state.customerName?.let {
            Text(it, style = MaterialTheme.typography.titleMedium, color = BrandRed)
          }
        }
      }
      Spacer(Modifier.height(Space.L.dp))
      CustomerLines(state.cart, Modifier.weight(1f))
      CustomerTotals(state.cart)
    }

    Box(Modifier.width(1.dp).fillMaxHeight().background(MaterialTheme.colorScheme.outline))

    Box(Modifier.weight(1f).fillMaxHeight()) {
      LoyaltyPanel(state.loyalty, onPhoneEntered, onDismiss)
    }
  }
}

@Composable
private fun CustomerLines(cart: Cart, modifier: Modifier = Modifier) {
  val listState = rememberLazyListState()
  // Follow the sale down. A customer watching their basket grow should not have
  // to be handed a scrolled-up screen to see what was just added.
  LaunchedEffect(cart.effectiveLines.size) {
    if (cart.effectiveLines.isNotEmpty()) listState.animateScrollToItem(cart.effectiveLines.lastIndex)
  }

  if (cart.isEmpty) {
    Column(
      modifier.fillMaxWidth(),
      verticalArrangement = Arrangement.Center,
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Text(
        "Welcome",
        style = MaterialTheme.typography.displaySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
    return
  }

  LazyColumn(modifier.fillMaxWidth(), state = listState) {
    items(cart.effectiveLines, key = { it.id }) { line ->
      Row(
        Modifier.fillMaxWidth().padding(vertical = Space.S.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          "${line.quantity}",
          style = MaterialTheme.typography.titleLarge.merge(MoneyTextStyle),
          color = MaterialTheme.colorScheme.onSurfaceVariant,
          modifier = Modifier.width(44.dp),
        )
        Text(
          line.description,
          style = MaterialTheme.typography.titleMedium,
          maxLines = 2,
          overflow = TextOverflow.Ellipsis,
          modifier = Modifier.weight(1f),
        )
        Text(
          line.total.toMajorString(),
          style = MaterialTheme.typography.titleLarge.merge(MoneyTextStyle),
        )
      }
      HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.5f))
    }
  }
}

@Composable
private fun CustomerTotals(cart: Cart) {
  Column(Modifier.fillMaxWidth().padding(top = Space.M.dp)) {
    CustomerTotalRow("Subtotal", cart.subtotal)
    if (!cart.discountTotal.isZero) CustomerTotalRow("Discount", -cart.discountTotal)
    CustomerTotalRow("Tax", cart.taxTotal)
    Spacer(Modifier.height(Space.S.dp))
    HorizontalDivider(color = MaterialTheme.colorScheme.outline)
    Spacer(Modifier.height(Space.S.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
      Text("TOTAL", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
      Text(
        "$${cart.total.toMajorString()}",
        style = MaterialTheme.typography.displayMedium.merge(MoneyTextStyle),
        fontWeight = FontWeight.Bold,
      )
    }
  }
}

@Composable
private fun CustomerTotalRow(label: String, amount: Money) {
  Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), horizontalArrangement = Arrangement.SpaceBetween) {
    Text(label, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Text(amount.toMajorString(), style = MaterialTheme.typography.titleMedium.merge(MoneyTextStyle))
  }
}

/**
 * The loyalty side.
 *
 * The customer types their own number. That is the whole reason this is worth
 * building: a phone number read aloud across a counter and typed by a cashier
 * is wrong often enough that the loyalty file fills up with near-duplicates,
 * and the customer is the only person in the building who knows their own
 * number.
 *
 * A number that is not on file is **not** signed up from here. The screen says
 * so and the cashier finishes it, because joining a programme is a record about
 * a person, and the two things that make it worth having -- a name, and the
 * customer actually agreeing -- are a conversation, not a keypad.
 */
@Composable
private fun LoyaltyPanel(
  loyalty: LoyaltyState,
  onPhoneEntered: (String) -> Unit,
  onDismiss: () -> Unit,
) {
  AnimatedContent(
    targetState = loyalty,
    transitionSpec = {
      (fadeIn(tween(Motion.SLOW)) + slideInVertically(tween(Motion.SLOW, easing = Motion.EaseOut)) { it / 8 })
        .togetherWith(fadeOut(tween(Motion.FAST)))
    },
    label = "loyalty",
  ) { current ->
    Box(Modifier.fillMaxSize().padding(Space.L.dp), contentAlignment = Alignment.Center) {
      when (current) {
        LoyaltyState.Closed -> LoyaltyResting()
        LoyaltyState.Offered, LoyaltyState.Entering -> PhonePad(onPhoneEntered, onDismiss)
        LoyaltyState.Searching -> LoyaltyMessage("Checking…") { CircularProgressIndicator(color = BrandOrange) }
        is LoyaltyState.Welcome -> LoyaltyMessage("Welcome back, ${current.name}") {
          Icon(Icons.Default.CheckCircle, null, tint = MaterialTheme.colorScheme.tertiary, modifier = Modifier.size(56.dp))
        }
        is LoyaltyState.NotOnFile -> LoyaltyMessage(
          "${current.phone} isn't on file yet — ask the cashier to add you.",
        ) {
          Icon(Icons.Default.CardGiftcard, null, tint = BrandOrange, modifier = Modifier.size(56.dp))
        }
        is LoyaltyState.Unavailable -> LoyaltyMessage(current.reason) {}
      }
    }
  }
}

@Composable
private fun LoyaltyResting() {
  Column(horizontalAlignment = Alignment.CenterHorizontally) {
    Icon(
      Icons.Default.CardGiftcard,
      null,
      tint = BrandOrange.copy(alpha = 0.5f),
      modifier = Modifier.size(52.dp),
    )
    Spacer(Modifier.height(Space.M.dp))
    Text("Rewards", style = MaterialTheme.typography.titleLarge)
    Text(
      "Ask about the loyalty programme",
      style = MaterialTheme.typography.bodyLarge,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      textAlign = TextAlign.Center,
    )
  }
}

@Composable
private fun LoyaltyMessage(text: String, icon: @Composable () -> Unit) {
  Column(horizontalAlignment = Alignment.CenterHorizontally) {
    icon()
    Spacer(Modifier.height(Space.M.dp))
    Text(
      text,
      style = MaterialTheme.typography.titleLarge,
      textAlign = TextAlign.Center,
    )
  }
}

/**
 * The keypad.
 *
 * Ten digits, a delete and a confirm, and nothing else. It is operated by a
 * stranger who will use it once, standing up, possibly holding a bag, so the
 * keys are enormous and the only formatting is the grouping that makes a
 * ten-digit number readable back to them.
 */
@Composable
private fun PhonePad(onDone: (String) -> Unit, onCancel: () -> Unit) {
  var digits by remember { mutableStateOf("") }

  Column(
    Modifier.fillMaxSize(),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center,
  ) {
    Text("Rewards", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Text("Enter your phone number", style = MaterialTheme.typography.titleLarge)
    Spacer(Modifier.height(Space.M.dp))
    Text(
      formatPhone(digits),
      style = MaterialTheme.typography.displaySmall.merge(MoneyTextStyle),
      color = if (digits.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
      else MaterialTheme.colorScheme.onSurface,
    )
    Spacer(Modifier.height(Space.L.dp))

    val rows = listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"))
    rows.forEach { row ->
      Row(horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
        row.forEach { key -> PadKey(key) { if (digits.length < 10) digits += key } }
      }
      Spacer(Modifier.height(Space.S.dp))
    }
    Row(horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
      PadKey("⌫", muted = true) { digits = digits.dropLast(1) }
      PadKey("0") { if (digits.length < 10) digits += "0" }
      PadKey(
        "✓",
        accent = digits.length == 10,
        enabled = digits.length == 10,
      ) { onDone(digits) }
    }
    Spacer(Modifier.height(Space.L.dp))
    Text(
      "No thanks",
      style = MaterialTheme.typography.bodyLarge,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      modifier = Modifier
        .clip(RoundedCornerShape(Corner.CHIP.dp))
        .clickable(onClick = onCancel)
        .padding(horizontal = Space.M.dp, vertical = Space.S.dp),
    )
  }
}

@Composable
private fun PadKey(
  label: String,
  accent: Boolean = false,
  muted: Boolean = false,
  enabled: Boolean = true,
  onClick: () -> Unit,
) {
  Box(
    Modifier
      .size(86.dp)
      .clip(RoundedCornerShape(Corner.CARD.dp))
      .background(
        when {
          accent -> BrandOrange
          !enabled -> MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)
          muted -> MaterialTheme.colorScheme.surfaceVariant
          else -> MaterialTheme.colorScheme.surface
        },
      )
      .clickable(enabled = enabled, onClick = onClick),
    contentAlignment = Alignment.Center,
  ) {
    if (label == "⌫") {
      Icon(Icons.Default.Backspace, "Delete", tint = MaterialTheme.colorScheme.onSurfaceVariant)
    } else {
      Text(
        label,
        style = MaterialTheme.typography.displaySmall,
        color = when {
          accent -> Color.White
          !enabled -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
          else -> MaterialTheme.colorScheme.onSurface
        },
      )
    }
  }
}

/** (254) 555-0137, filled in as they type. Grouping is the only help a ten digit number needs. */
private fun formatPhone(digits: String): String {
  if (digits.isEmpty()) return "(___) ___-____"
  val padded = digits.padEnd(10, '_')
  return "(${padded.take(3)}) ${padded.drop(3).take(3)}-${padded.drop(6).take(4)}"
}

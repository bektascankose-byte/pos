package com.snappos.pos.ui

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
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
 *
 * The basket is on the left and rewards on the right, except while an email
 * is being typed: a keyboard needs the whole width, so it takes it, and gives
 * it back the moment they are done.
 */
@Composable
fun CustomerScreen(state: CustomerScreenState, actions: RewardsActions) {
  Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
    Crossfade(
      targetState = state.rewards is RewardsPanel.EnterEmail,
      animationSpec = tween(Motion.NORMAL),
      label = "customer screen",
    ) { typingEmail ->
      if (typingEmail) {
        EmailEntry(
          // Read as it is now, not as it was when the fade began: while this
          // side is fading out the panel has already moved on.
          problem = (state.rewards as? RewardsPanel.EnterEmail)?.problem,
          total = state.cart.total.takeUnless { state.cart.isEmpty },
          actions = actions,
        )
      } else {
        BasketAndRewards(state, actions)
      }
    }
  }
}

@Composable
private fun BasketAndRewards(state: CustomerScreenState, actions: RewardsActions) {
  Row(Modifier.fillMaxSize()) {
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
      val completed = state.completed
      if (completed != null && state.cart.isEmpty) {
        CustomerThanks(completed, Modifier.weight(1f))
      } else {
        CustomerLines(state.cart, Modifier.weight(1f))
        CustomerTotals(state.cart)
      }
    }

    Box(Modifier.width(1.dp).fillMaxHeight().background(MaterialTheme.colorScheme.outline))

    Box(Modifier.weight(1f).fillMaxHeight()) {
      RewardsSide(state.rewards, actions)
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
 * After the sale: what it came to, and the change.
 *
 * Without this the basket empties the instant the sale commits and the screen
 * goes back to "Welcome" while the customer is still holding out their hand
 * for change, which reads as the till having forgotten them. The change is
 * given the same weight the total had a moment ago, because it is now the
 * number they are checking against what is put in their hand.
 */
@Composable
private fun CustomerThanks(sale: CompletedSale, modifier: Modifier = Modifier) {
  Column(
    modifier.fillMaxWidth(),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Icon(
      Icons.Default.CheckCircle,
      null,
      tint = MaterialTheme.colorScheme.tertiary,
      modifier = Modifier.size(56.dp),
    )
    Spacer(Modifier.height(Space.M.dp))
    Text("Thank you", style = MaterialTheme.typography.displaySmall)
    Spacer(Modifier.height(Space.L.dp))
    CustomerTotalRow("Total", sale.total)
    if (!sale.change.isZero) {
      Spacer(Modifier.height(Space.S.dp))
      HorizontalDivider(color = MaterialTheme.colorScheme.outline)
      Spacer(Modifier.height(Space.S.dp))
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text("CHANGE", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
        Text(
          "$${sale.change.toMajorString()}",
          style = MaterialTheme.typography.displayMedium.merge(MoneyTextStyle),
          fontWeight = FontWeight.Bold,
        )
      }
    }
  }
}

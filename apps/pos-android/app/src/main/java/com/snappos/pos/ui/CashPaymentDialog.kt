package com.snappos.pos.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.snappos.domain.Money

/**
 * Taking cash.
 *
 * Two things a cashier does here, hundreds of times a day: tap a quick-cash
 * button, or type an amount. Both are one gesture, and the change due is shown
 * as large as the total because getting change wrong is the most common
 * counter mistake there is.
 *
 * The keypad is deliberately not the system keyboard. A numeric IME on a
 * terminal is small, slow to appear, and moves the layout when it does.
 */
@Composable
fun CashPaymentDialog(
  total: Money,
  onDismiss: () -> Unit,
  onConfirm: (Money) -> Unit,
) {
  // Digits as typed, interpreted as minor units: typing 5 0 0 0 means $50.00.
  // Cashiers on every POS enter cash this way, and a decimal point is a keypress
  // that can be missed by a factor of a hundred.
  var digits by remember { mutableStateOf("") }

  val tendered = Money.ofMinor(digits.ifEmpty { "0" }.toLong())
  val change = tendered - total
  val sufficient = tendered >= total

  Dialog(onDismissRequest = onDismiss) {
    Surface(
      shape = RoundedCornerShape(12.dp),
      color = MaterialTheme.colorScheme.surface,
      modifier = Modifier.width(420.dp),
    ) {
      Column(Modifier.padding(Space.L.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
          Text("Total due", style = MaterialTheme.typography.bodyLarge)
          Text(
            total.toMajorString(),
            style = MaterialTheme.typography.headlineMedium.merge(MoneyTextStyle),
          )
        }

        Spacer(Modifier.height(Space.M.dp))

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
          Text("Tendered", style = MaterialTheme.typography.bodyLarge)
          Text(
            tendered.toMajorString(),
            style = MaterialTheme.typography.headlineMedium.merge(MoneyTextStyle),
            color = MaterialTheme.colorScheme.primary,
          )
        }

        Spacer(Modifier.height(Space.S.dp))

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
          Text(
            "Change",
            style = MaterialTheme.typography.titleLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
          Text(
            if (sufficient) change.toMajorString() else "—",
            // As large as the total on purpose: handing back the wrong change is
            // the most common mistake at a counter.
            style = MaterialTheme.typography.displaySmall.merge(MoneyTextStyle),
            color = if (sufficient) MaterialTheme.colorScheme.tertiary
            else MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }

        Spacer(Modifier.height(Space.M.dp))

        // Exact, then the notes a customer actually hands over.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
          // weight() lives on RowScope, so the caller supplies it rather than
          // the helper trying to reach for a scope it is not in.
          QuickCash("Exact", Modifier.weight(1f)) { digits = total.minor.toString() }
          for (note in listOf(5L, 10L, 20L)) {
            QuickCash("$$note", Modifier.weight(1f)) { digits = (note * 100).toString() }
          }
        }

        Spacer(Modifier.height(Space.M.dp))
        Keypad(
          onDigit = { digit ->
            // Capped so a stray repeat cannot produce an absurd tender.
            if (digits.length < 9) digits += digit
          },
          onBackspace = { digits = digits.dropLast(1) },
          onClear = { digits = "" },
        )

        Spacer(Modifier.height(Space.M.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
          TextButton(onClick = onDismiss, modifier = Modifier.weight(1f).height(Touch.MIN.dp)) {
            Text("Cancel")
          }
          Button(
            onClick = { onConfirm(tendered) },
            enabled = sufficient,
            modifier = Modifier.weight(2f).height(Touch.PRIMARY.dp),
            shape = RoundedCornerShape(6.dp),
          ) {
            Text("TAKE CASH", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
          }
        }
      }
    }
  }
}

@Composable
private fun QuickCash(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
  Box(
    modifier
      .height(Touch.MIN.dp)
      .clip(RoundedCornerShape(6.dp))
      .background(MaterialTheme.colorScheme.surfaceVariant)
      .clickable(onClick = onClick),
    contentAlignment = Alignment.Center,
  ) {
    Text(label, style = MaterialTheme.typography.bodyLarge.merge(MoneyTextStyle))
  }
}

@Composable
private fun Keypad(onDigit: (String) -> Unit, onBackspace: () -> Unit, onClear: () -> Unit) {
  val rows = listOf(
    listOf("1", "2", "3"),
    listOf("4", "5", "6"),
    listOf("7", "8", "9"),
    listOf("C", "0", "⌫"),
  )
  Column(verticalArrangement = Arrangement.spacedBy(Space.S.dp)) {
    rows.forEach { row ->
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
        row.forEach { key ->
          Box(
            Modifier
              .weight(1f)
              .height(Touch.MIN.dp)
              .clip(RoundedCornerShape(6.dp))
              .background(MaterialTheme.colorScheme.surfaceVariant)
              .clickable {
                when (key) {
                  "C" -> onClear()
                  "⌫" -> onBackspace()
                  else -> onDigit(key)
                }
              },
            contentAlignment = Alignment.Center,
          ) {
            Text(key, style = MaterialTheme.typography.headlineMedium.merge(MoneyTextStyle))
          }
        }
      }
    }
  }
}

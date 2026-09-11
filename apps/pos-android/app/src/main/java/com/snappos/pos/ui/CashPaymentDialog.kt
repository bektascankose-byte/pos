package com.snappos.pos.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
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
import androidx.compose.ui.window.DialogProperties
import com.snappos.domain.Money

/**
 * Taking cash.
 *
 * Two things a cashier does here hundreds of times a day: tap a quick-cash
 * button, or type an amount. Both are one gesture, and the change due is shown
 * as large as the total because handing back the wrong change is the most
 * common mistake at a counter.
 *
 * The keypad is deliberately not the system keyboard. A numeric IME on a
 * terminal is small, slow to appear, and shifts the layout when it does.
 *
 * **Two layouts, chosen by height.** A register in landscape has roughly 380dp
 * of vertical space, and a single stacked column does not fit — the first
 * version of this dialog pushed TAKE CASH off the bottom of the screen, which
 * made the sale impossible to complete rather than merely awkward. Short
 * screens get amounts and actions beside the keypad instead of above it.
 */
@Composable
fun CashPaymentDialog(
  total: Money,
  onDismiss: () -> Unit,
  onConfirm: (Money) -> Unit,
  /** "Total due" when taking a tender, "Expected" when counting a drawer. */
  title: String = "Total due",
  confirmLabel: String = "TAKE CASH",
) {
  // Digits as typed, interpreted as minor units: typing 5 0 0 0 means $50.00.
  // Cashiers on every POS enter cash this way, and a decimal point is a keypress
  // that can be missed by a factor of a hundred.
  var digits by remember { mutableStateOf("") }

  val tendered = Money.ofMinor(digits.ifEmpty { "0" }.toLong())
  val change = tendered - total

  // Counting a drawer has no "due" amount, so there is nothing to be short of
  // and the confirm button must not be gated on covering a total of zero.
  val counting = total.isZero
  val sufficient = tendered >= total

  Dialog(
    onDismissRequest = onDismiss,
    properties = DialogProperties(usePlatformDefaultWidth = false),
  ) {
    BoxWithConstraints {
      val sideBySide = maxHeight < 560.dp

      Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier
          .padding(Space.M.dp)
          .widthIn(max = if (sideBySide) 720.dp else 420.dp),
      ) {
        if (sideBySide) {
          Row(Modifier.padding(Space.M.dp)) {
            Column(Modifier.weight(1f).padding(end = Space.M.dp)) {
              Amounts(total, tendered, change, sufficient, title, counting)
              Spacer(Modifier.height(Space.M.dp))
              QuickCashRow(total) { digits = it }
              Spacer(Modifier.weight(1f))
              Actions(sufficient || counting, confirmLabel, onDismiss) { onConfirm(tendered) }
            }
            Box(Modifier.weight(1f)) {
              Keypad(
                onDigit = { if (digits.length < 9) digits += it },
                onBackspace = { digits = digits.dropLast(1) },
                onClear = { digits = "" },
              )
            }
          }
        } else {
          Column(Modifier.padding(Space.L.dp)) {
            Amounts(total, tendered, change, sufficient, title, counting)
            Spacer(Modifier.height(Space.M.dp))
            QuickCashRow(total) { digits = it }
            Spacer(Modifier.height(Space.M.dp))
            Keypad(
              onDigit = { if (digits.length < 9) digits += it },
              onBackspace = { digits = digits.dropLast(1) },
              onClear = { digits = "" },
            )
            Spacer(Modifier.height(Space.M.dp))
            Actions(sufficient || counting, confirmLabel, onDismiss) { onConfirm(tendered) }
          }
        }
      }
    }
  }
}

@Composable
private fun ColumnScope.Amounts(
  total: Money,
  tendered: Money,
  change: Money,
  sufficient: Boolean,
  title: String,
  counting: Boolean,
) {
  if (!counting) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
      Text(title, style = MaterialTheme.typography.bodyLarge)
      Text(total.toMajorString(), style = MaterialTheme.typography.headlineMedium.merge(MoneyTextStyle))
    }
    Spacer(Modifier.height(Space.S.dp))
  }
  Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
    Text(if (counting) "Counted" else "Tendered", style = MaterialTheme.typography.bodyLarge)
    Text(
      tendered.toMajorString(),
      style = MaterialTheme.typography.headlineMedium.merge(MoneyTextStyle),
      color = MaterialTheme.colorScheme.primary,
    )
  }
  if (counting) return
  Spacer(Modifier.height(Space.S.dp))
  Row(
    Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.SpaceBetween,
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      "Change",
      style = MaterialTheme.typography.titleLarge,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Text(
      if (sufficient) change.toMajorString() else "—",
      // As large as the total on purpose.
      style = MaterialTheme.typography.displaySmall.merge(MoneyTextStyle),
      color = if (sufficient) MaterialTheme.colorScheme.tertiary
      else MaterialTheme.colorScheme.onSurfaceVariant,
    )
  }
}

/** Exact, then the notes a customer actually hands over. */
@Composable
private fun QuickCashRow(total: Money, onPick: (String) -> Unit) {
  Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
    QuickCash("Exact", Modifier.weight(1f)) { onPick(total.minor.toString()) }
    for (note in listOf(5L, 10L, 20L)) {
      QuickCash("$$note", Modifier.weight(1f)) { onPick((note * 100).toString()) }
    }
  }
}

@Composable
private fun Actions(
  enabled: Boolean,
  confirmLabel: String,
  onCancel: () -> Unit,
  onConfirm: () -> Unit,
) {
  Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
    TextButton(onClick = onCancel, modifier = Modifier.weight(1f).height(Touch.MIN.dp)) {
      Text("Cancel")
    }
    Button(
      onClick = onConfirm,
      enabled = enabled,
      modifier = Modifier.weight(2f).height(Touch.PRIMARY.dp),
      shape = RoundedCornerShape(6.dp),
    ) {
      Text(confirmLabel, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
    }
  }
}

@Composable
private fun RowScope.QuickCash(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
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
    listOf("C", "0", "<"),
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
                  "<" -> onBackspace()
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

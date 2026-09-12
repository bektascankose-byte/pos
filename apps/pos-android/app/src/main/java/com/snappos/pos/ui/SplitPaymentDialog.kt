package com.snappos.pos.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.snappos.data.Tender
import com.snappos.domain.Money

/** One tender a cashier has already added to a split sale, before it is committed. */
private data class SplitEntry(
  val method: String,
  val label: String,
  val amount: Money,
  val tendered: Money?,
  val change: Money,
)

/**
 * Cover one sale with more than one tender.
 *
 * Cash still tenders and makes change exactly like [CashPaymentDialog] — a
 * cash entry that covers what's left over gives change back the same way a
 * single-tender cash sale does. Anything else (a card run on the shop's own
 * terminal, a gift card, a check) is recorded for its exact amount only:
 * there is no reader wired into this register, so this dialog never claims
 * to process a card — it only records that a specific amount was taken by
 * some other means, which is the honest version of "split tender" without
 * card hardware.
 *
 * Entries are held locally until "Complete sale" is tapped, so a cashier can
 * remove one they mis-entered before anything commits — nothing here is a
 * partial commit to [com.snappos.data.SaleRepository].
 */
@Composable
fun SplitPaymentDialog(
  total: Money,
  onDismiss: () -> Unit,
  onConfirm: (List<Tender>) -> Unit,
) {
  var entries by remember { mutableStateOf(listOf<SplitEntry>()) }
  // null = the entry list; "cash" / "other" = the keypad for that method.
  var entering by remember { mutableStateOf<String?>(null) }
  var digits by remember { mutableStateOf("") }

  val paid = Money.sum(entries.map { it.amount })
  val remaining = total - paid
  val covered = remaining <= Money.ZERO
  val entered = Money.ofMinor(digits.ifEmpty { "0" }.toLong())

  Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
    Surface(
      shape = RoundedCornerShape(12.dp),
      color = MaterialTheme.colorScheme.surface,
      modifier = Modifier.padding(Space.M.dp).widthIn(max = 420.dp),
    ) {
      // Scrollable: a short landscape register has no room to spare, and this
      // dialog's own content (entry list, add-cash/add-other buttons, keypad)
      // is taller than that available height on the primary target device.
      // Without scroll, the bottom of the keypad and the Add/Complete sale
      // buttons are silently clipped off-screen and unreachable — the same
      // failure mode the compact CartPanel header had before it was fixed.
      Column(Modifier.padding(Space.L.dp).verticalScroll(rememberScrollState())) {
        if (entering == null) {
          Text("Split payment", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
          Spacer(Modifier.height(Space.S.dp))
          Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Total due", style = MaterialTheme.typography.bodyLarge)
            Text(total.toMajorString(), style = MaterialTheme.typography.headlineMedium.merge(MoneyTextStyle))
          }
          Spacer(Modifier.height(Space.S.dp))
          Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(
              if (covered) "Covered" else "Remaining",
              style = MaterialTheme.typography.titleLarge,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
              if (covered) "$0.00" else remaining.toMajorString(),
              style = MaterialTheme.typography.displaySmall.merge(MoneyTextStyle),
              color = if (covered) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant,
            )
          }
          Spacer(Modifier.height(Space.M.dp))

          if (entries.isNotEmpty()) {
            LazyColumn(Modifier.heightIn(max = 200.dp)) {
              items(entries) { entry ->
                Row(
                  Modifier.fillMaxWidth().padding(vertical = Space.XS.dp),
                  horizontalArrangement = Arrangement.SpaceBetween,
                  verticalAlignment = Alignment.CenterVertically,
                ) {
                  Column {
                    Text(entry.label, style = MaterialTheme.typography.bodyLarge)
                    if (entry.tendered != null && !entry.change.isZero) {
                      Text(
                        "Tendered ${entry.tendered.toMajorString()}, change ${entry.change.toMajorString()}",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                      )
                    }
                  }
                  Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(entry.amount.toMajorString(), style = MaterialTheme.typography.bodyLarge.merge(MoneyTextStyle))
                    IconButton(onClick = { entries = entries - entry }) {
                      Icon(Icons.Default.Close, "Remove ${entry.label}")
                    }
                  }
                }
              }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            Spacer(Modifier.height(Space.S.dp))
          }

          if (!covered) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
              Button(
                onClick = { digits = ""; entering = "cash" },
                modifier = Modifier.weight(1f).height(Touch.MIN.dp),
              ) { Text("Add cash") }
              OutlinedButton(
                onClick = { digits = ""; entering = "other" },
                modifier = Modifier.weight(1f).height(Touch.MIN.dp),
              ) { Text("Add other") }
            }
            Spacer(Modifier.height(Space.M.dp))
          }

          Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
            TextButton(onClick = onDismiss, modifier = Modifier.weight(1f).height(Touch.MIN.dp)) {
              Text("Cancel")
            }
            Button(
              onClick = {
                onConfirm(
                  entries.map { entry ->
                    Tender(
                      method = entry.method,
                      amount = entry.amount,
                      tendered = entry.tendered,
                      change = entry.change,
                    )
                  },
                )
              },
              enabled = covered,
              modifier = Modifier.weight(2f).height(Touch.PRIMARY.dp),
              shape = RoundedCornerShape(6.dp),
            ) {
              Text("Complete sale", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            }
          }
        } else {
          val method = entering!!
          val isCash = method == "cash"
          Text(
            if (isCash) "Add cash" else "Add other payment",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold,
          )
          Spacer(Modifier.height(Space.S.dp))
          Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Remaining", style = MaterialTheme.typography.bodyLarge)
            Text(remaining.toMajorString(), style = MaterialTheme.typography.headlineMedium.merge(MoneyTextStyle))
          }
          Spacer(Modifier.height(Space.S.dp))
          Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(
              if (isCash) "Tendered" else "Amount",
              style = MaterialTheme.typography.bodyLarge,
            )
            Text(
              entered.toMajorString(),
              style = MaterialTheme.typography.headlineMedium.merge(MoneyTextStyle),
              color = MaterialTheme.colorScheme.primary,
            )
          }
          // A card, gift card or check tender is exact — there is no reader
          // here to produce change from it, so it can never exceed what's left.
          val overOther = !isCash && entered > Money.ZERO && entered > remaining
          if (overOther) {
            Text(
              "Cannot exceed the remaining ${remaining.toMajorString()}",
              style = MaterialTheme.typography.labelMedium,
              color = MaterialTheme.colorScheme.error,
            )
          }
          Spacer(Modifier.height(Space.S.dp))
          Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
            QuickAmount("Exact", Modifier.weight(1f)) { digits = remaining.minor.toString() }
          }
          Spacer(Modifier.height(Space.S.dp))
          Keypad(
            onDigit = { if (digits.length < 9) digits += it },
            onBackspace = { digits = digits.dropLast(1) },
            onClear = { digits = "" },
          )
          Spacer(Modifier.height(Space.M.dp))
          Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
            TextButton(onClick = { entering = null }, modifier = Modifier.weight(1f).height(Touch.MIN.dp)) {
              Text("Back")
            }
            Button(
              onClick = {
                val amount = if (isCash && entered >= remaining) remaining else entered
                val change = if (isCash) entered - amount else Money.ZERO
                entries = entries + SplitEntry(
                  method = method,
                  label = if (isCash) "Cash" else "Other",
                  amount = amount,
                  tendered = if (isCash) entered else null,
                  change = change,
                )
                entering = null
              },
              enabled = entered > Money.ZERO && !overOther,
              modifier = Modifier.weight(2f).height(Touch.PRIMARY.dp),
              shape = RoundedCornerShape(6.dp),
            ) { Text("Add", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold) }
          }
        }
      }
    }
  }
}

@Composable
private fun QuickAmount(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
  Box(
    modifier
      .height(Touch.MIN.dp)
      .clickable(onClick = onClick)
      .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(6.dp)),
    contentAlignment = Alignment.Center,
  ) {
    Text(label, style = MaterialTheme.typography.bodyLarge.merge(MoneyTextStyle))
  }
}

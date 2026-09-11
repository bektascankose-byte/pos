package com.snappos.pos.ui

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
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.snappos.data.RefundableLine
import com.snappos.data.RefundableSale
import com.snappos.domain.Money

/**
 * Refunding against a receipt.
 *
 * The flow is deliberately narrow: find the original sale, pick what is coming
 * back, say why, and have a manager approve it. There is no way here to refund
 * an arbitrary amount with no original, because that is the hole employee theft
 * goes through, and a register that makes it easy is a register that invites it.
 *
 * `refundable` per line is shown before anything is selected, so a cashier is
 * told "only 1 of 3 left" before promising a customer anything rather than
 * after.
 */
@Composable
fun RefundScreen(
  sale: RefundableSale?,
  lookupError: String?,
  selections: Map<String, Int>,
  restockFlags: Map<String, Boolean>,
  reasonCode: String,
  busy: Boolean,
  onLookup: (String) -> Unit,
  onQuantity: (String, Int) -> Unit,
  onToggleRestock: (String) -> Unit,
  onReason: (String) -> Unit,
  onSubmit: () -> Unit,
  onCancel: () -> Unit,
  onVoid: () -> Unit = {},
) {
  Surface(color = MaterialTheme.colorScheme.background) {
    Column(Modifier.fillMaxSize().safeDrawingPadding()) {
      Row(
        Modifier
          .fillMaxWidth()
          .background(MaterialTheme.colorScheme.surface)
          .padding(horizontal = Space.M.dp, vertical = Space.S.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text("REFUND", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.weight(1f))
        // Offered only while the whole sale is still returnable. Refunding one
        // of two units and then voiding the sale would put three units back on
        // the shelf and more money in the customer's hand than they ever paid,
        // so the action is not shown rather than shown and refused.
        if (sale != null && sale.lines.none { it.alreadyRefunded > 0.0001 }) {
          TextButton(onClick = onVoid, enabled = !busy) { Text("Void entire sale") }
        }
        TextButton(onClick = onCancel) { Text("Cancel") }
      }
      HorizontalDivider(color = MaterialTheme.colorScheme.outline)

      if (sale == null) {
        ReceiptLookup(lookupError, onLookup)
        return@Column
      }

      Row(Modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).fillMaxHeight().padding(Space.M.dp)) {
          Text(
            sale.receiptNo,
            style = MaterialTheme.typography.titleLarge.merge(MoneyTextStyle),
          )
          Text(
            "Original total ${Money.ofMinor(sale.totalMinor).toMajorString()}",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
          Spacer(Modifier.height(Space.M.dp))

          LazyColumn(verticalArrangement = Arrangement.spacedBy(Space.S.dp)) {
            items(sale.lines, key = { it.saleLineId }) { line ->
              RefundLineRow(
                line = line,
                quantity = selections[line.saleLineId] ?: 0,
                restock = restockFlags[line.saleLineId] ?: true,
                onQuantity = { onQuantity(line.saleLineId, it) },
                onToggleRestock = { onToggleRestock(line.saleLineId) },
              )
            }
          }
        }

        Box(Modifier.width(1.dp).fillMaxHeight().background(MaterialTheme.colorScheme.outline))

        Column(
          Modifier.width(340.dp).fillMaxHeight()
            .background(MaterialTheme.colorScheme.surface)
            .padding(Space.M.dp),
        ) {
          Text(
            "WHY",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
          Spacer(Modifier.height(Space.S.dp))
          // A required reason, from a fixed list. Free text alone produces
          // "return" on every line and a loss prevention report nobody can
          // group by.
          //
          // Scrolled, and given the leftover height rather than its natural
          // height, so that the amount and the approval button below are
          // always on screen. A phone in landscape is about 384dp tall and
          // five reasons plus a footer do not fit in it - without this the
          // button is clipped and the refund cannot be completed at all.
          Column(
            Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
          ) {
            for (reason in REASONS) {
              ReasonRow(reason.second, reasonCode == reason.first) { onReason(reason.first) }
            }
          }

          Spacer(Modifier.height(Space.S.dp))

          val total = Money.ofMinor(
            sale.lines.sumOf { line ->
              val qty = selections[line.saleLineId] ?: 0
              (line.unitPrice.minor + line.taxPerUnit.minor) * qty
            },
          )

          Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("REFUND", style = MaterialTheme.typography.titleLarge)
            Text(
              total.toMajorString(),
              style = MaterialTheme.typography.titleLarge.merge(MoneyTextStyle),
            )
          }

          lookupError?.let {
            Spacer(Modifier.height(Space.S.dp))
            Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
          }

          Spacer(Modifier.height(Space.M.dp))
          Button(
            onClick = onSubmit,
            enabled = !busy && selections.values.any { it > 0 },
            modifier = Modifier.fillMaxWidth().height(Touch.PRIMARY.dp),
            shape = RoundedCornerShape(6.dp),
          ) {
            // Named for what happens next: a manager has to stand here and
            // enter a PIN, and the button should say so rather than surprise
            // the cashier with a prompt.
            Text(
              "MANAGER APPROVAL",
              style = MaterialTheme.typography.titleLarge,
              fontWeight = FontWeight.SemiBold,
            )
          }
        }
      }
    }
  }
}

private val REASONS = listOf(
  "customer_changed_mind" to "Changed their mind",
  "defective" to "Faulty or defective",
  "wrong_item" to "Wrong item",
  "damaged" to "Damaged",
  "price_dispute" to "Price dispute",
)

@Composable
private fun ReceiptLookup(error: String?, onLookup: (String) -> Unit) {
  var receipt by remember { mutableStateOf("") }

  Column(
    Modifier.fillMaxSize().padding(Space.L.dp),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text("Find the original sale", style = MaterialTheme.typography.headlineMedium)
    Text(
      "Enter the receipt number from the customer's receipt",
      style = MaterialTheme.typography.bodyMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.height(Space.M.dp))

    OutlinedTextField(
      value = receipt,
      onValueChange = { receipt = it.uppercase() },
      modifier = Modifier.width(420.dp),
      singleLine = true,
      placeholder = { Text("HH01-R1-12") },
    )

    error?.let {
      Spacer(Modifier.height(Space.S.dp))
      Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
    }

    Spacer(Modifier.height(Space.M.dp))
    Button(
      onClick = { onLookup(receipt) },
      enabled = receipt.isNotBlank(),
      modifier = Modifier.width(420.dp).height(Touch.PRIMARY.dp),
      shape = RoundedCornerShape(6.dp),
    ) {
      Text("FIND SALE", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
    }
  }
}

@Composable
private fun RefundLineRow(
  line: RefundableLine,
  quantity: Int,
  restock: Boolean,
  onQuantity: (Int) -> Unit,
  onToggleRestock: () -> Unit,
) {
  Column(
    Modifier
      .fillMaxWidth()
      .clip(RoundedCornerShape(6.dp))
      .background(MaterialTheme.colorScheme.surface)
      .padding(Space.M.dp),
  ) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
      Text(
        line.description,
        style = MaterialTheme.typography.bodyLarge,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.weight(1f),
      )
      Text(
        line.unitPrice.toMajorString(),
        style = MaterialTheme.typography.bodyLarge.merge(MoneyTextStyle),
      )
    }

    Text(
      if (line.fullyRefunded) "Fully refunded"
      else "${line.refundable.toInt()} of ${line.sold.toInt()} still refundable",
      style = MaterialTheme.typography.labelMedium,
      color = if (line.fullyRefunded) MaterialTheme.colorScheme.onSurfaceVariant
      else MaterialTheme.colorScheme.tertiary,
    )

    if (line.fullyRefunded) return@Column

    Spacer(Modifier.height(Space.S.dp))
    Row(
      Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        StepButton("−") { onQuantity((quantity - 1).coerceAtLeast(0)) }
        Text(
          quantity.toString(),
          style = MaterialTheme.typography.titleLarge.merge(MoneyTextStyle),
          modifier = Modifier.padding(horizontal = Space.M.dp),
        )
        StepButton("+") {
          onQuantity((quantity + 1).coerceAtMost(line.refundable.toInt()))
        }
      }

      // Restock is a per line decision: an opened drink comes back as a refund
      // but not as stock, and getting that wrong drifts the count by exactly
      // the number of damaged returns.
      Row(
        Modifier
          .clip(RoundedCornerShape(999.dp))
          .background(
            if (restock) MaterialTheme.colorScheme.tertiary.copy(alpha = 0.15f)
            else MaterialTheme.colorScheme.secondary.copy(alpha = 0.15f),
          )
          .clickable(onClick = onToggleRestock)
          .padding(horizontal = Space.M.dp, vertical = Space.S.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          if (restock) "Back on shelf" else "Not resellable",
          style = MaterialTheme.typography.labelMedium,
          color = if (restock) MaterialTheme.colorScheme.tertiary
          else MaterialTheme.colorScheme.secondary,
        )
      }
    }
  }
}

@Composable
private fun ReasonRow(label: String, selected: Boolean, onClick: () -> Unit) {
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
      color = if (selected) MaterialTheme.colorScheme.primary
      else MaterialTheme.colorScheme.onBackground,
    )
  }
}

@Composable
private fun StepButton(label: String, onClick: () -> Unit) {
  Box(
    Modifier
      .size(44.dp)
      .clip(RoundedCornerShape(6.dp))
      .background(MaterialTheme.colorScheme.surfaceVariant)
      .clickable(onClick = onClick),
    contentAlignment = Alignment.Center,
  ) {
    Text(label, style = MaterialTheme.typography.titleLarge)
  }
}

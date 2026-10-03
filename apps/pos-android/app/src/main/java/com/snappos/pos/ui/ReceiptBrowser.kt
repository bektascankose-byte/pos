package com.snappos.pos.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.snappos.data.ReceiptSummary
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * The receipts this register has taken, to find one again.
 *
 * Built around the case that actually happens: a customer wants a copy and
 * does not have the slip, because losing it is why they are asking. So the
 * day is listed and the receipt number narrows the list rather than being
 * the way in. Yesterday and a date of your choosing are one tap away,
 * because "I bought it Tuesday" is the other thing customers say.
 *
 * Reads only what is on this device, so it works with the shop's internet
 * down. A receipt was rung here and is stored here.
 */
@Composable
fun ReceiptBrowserDialog(
  day: LocalDate,
  receipts: List<ReceiptSummary>,
  query: String,
  loading: Boolean,
  onQuery: (String) -> Unit,
  onPickDay: (LocalDate) -> Unit,
  onOpen: (saleId: String) -> Unit,
  onDismiss: () -> Unit,
) {
  val today = LocalDate.now()
  // Narrowed here rather than by re-reading the day: the list is one day's
  // takings, small enough to filter in place, and doing it in memory keeps
  // the list responsive as each character is typed.
  val shown = if (query.isBlank()) {
    receipts
  } else {
    receipts.filter { it.receiptNo.contains(query.trim(), ignoreCase = true) }
  }

  Dialog(onDismissRequest = onDismiss) {
    Surface(
      shape = RoundedCornerShape(12.dp),
      color = MaterialTheme.colorScheme.surface,
      modifier = Modifier.width(520.dp),
    ) {
      Column(Modifier.padding(Space.M.dp)) {
        Text(
          "RECEIPTS",
          style = MaterialTheme.typography.titleMedium,
          fontWeight = FontWeight.SemiBold,
        )
        Text(
          day.format(DAY),
          style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(Space.S.dp))

        Row(verticalAlignment = Alignment.CenterVertically) {
          TextButton(onClick = { onPickDay(day.minusDays(1)) }) { Text("◀ Earlier") }
          if (day != today) {
            TextButton(onClick = { onPickDay(today) }) { Text("Today") }
            TextButton(onClick = { onPickDay(day.plusDays(1)) }) { Text("Later ▶") }
          }
        }

        OutlinedTextField(
          value = query,
          onValueChange = onQuery,
          singleLine = true,
          label = { Text("Receipt number, if they have it") },
          keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
          modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(Space.S.dp))

        when {
          loading -> Text(
            "Looking…",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
          shown.isEmpty() && query.isNotBlank() -> Text(
            "No receipt on this day matches \"$query\". Try another date.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
          shown.isEmpty() -> Text(
            "Nothing was rung on this register that day.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
          else -> LazyColumn(Modifier.heightIn(max = 360.dp)) {
            items(shown, key = { it.saleId }) { receipt ->
              ReceiptRow(receipt, onOpen)
              HorizontalDivider()
            }
          }
        }

        Spacer(Modifier.height(Space.S.dp))

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
          TextButton(onClick = onDismiss) { Text("Close") }
        }
      }
    }
  }
}

@Composable
private fun ReceiptRow(receipt: ReceiptSummary, onOpen: (String) -> Unit) {
  Row(
    Modifier
      .fillMaxWidth()
      .clickable { onOpen(receipt.saleId) }
      .padding(vertical = Space.S.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Column(Modifier.weight(1f)) {
      Text(
        receipt.receiptNo,
        style = MaterialTheme.typography.bodyMedium,
        fontWeight = FontWeight.SemiBold,
      )
      Text(
        buildString {
          append(TIME.format(Instant.ofEpochMilli(receipt.soldAtMillis).atZone(ZoneId.systemDefault())))
          append(" · ")
          append(if (receipt.itemCount == 1) "1 item" else "${receipt.itemCount} items")
          append(" · ")
          append(receipt.tenders)
          // Said plainly rather than left for the cashier to notice on the
          // slip: handing a voided receipt to a customer as proof of
          // purchase is a mistake worth making hard to make.
          if (receipt.voided) append(" · VOIDED")
        },
        style = MaterialTheme.typography.bodySmall,
        color = if (receipt.voided) {
          MaterialTheme.colorScheme.error
        } else {
          MaterialTheme.colorScheme.onSurfaceVariant
        },
      )
    }
    Text(
      receipt.total.toMajorString(),
      style = MaterialTheme.typography.bodyMedium,
      fontWeight = FontWeight.SemiBold,
    )
  }
}

private val DAY: DateTimeFormatter = DateTimeFormatter.ofPattern("EEEE d MMMM")
private val TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("h:mm a")

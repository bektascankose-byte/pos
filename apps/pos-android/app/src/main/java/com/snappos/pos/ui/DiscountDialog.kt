package com.snappos.pos.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.snappos.domain.Money
import com.snappos.domain.applyRate
import java.math.BigDecimal

enum class DiscountEntryMode { Amount, Percentage, Target }

@Composable
fun DiscountDialog(
  lineName: String,
  maximum: Money,
  basis: Money = maximum,
  allowTarget: Boolean = false,
  title: String = "Discount item",
  onDismiss: () -> Unit,
  onApply: (Money, String) -> Unit,
) {
  var amount by remember { mutableStateOf("") }
  var reason by remember { mutableStateOf("customer_courtesy") }
  var mode by remember { mutableStateOf(DiscountEntryMode.Amount) }
  val entered = runCatching { Money.fromMajor(amount) }.getOrNull()
  val parsed = when (mode) {
    DiscountEntryMode.Amount -> entered
    DiscountEntryMode.Percentage -> runCatching {
      val percent = BigDecimal(amount)
      require(percent > BigDecimal.ZERO && percent <= BigDecimal("100"))
      basis.applyRate(percent.movePointLeft(2).stripTrailingZeros().toPlainString())
    }.getOrNull()
    DiscountEntryMode.Target -> entered?.let { target ->
      if (target <= maximum) maximum - target else null
    }
  }
  val valid = parsed != null && !parsed.isZero && !parsed.isNegative && parsed <= maximum

  AlertDialog(
    onDismissRequest = onDismiss,
    shape = RoundedCornerShape(20.dp),
    title = { Text(title, fontWeight = FontWeight.SemiBold) },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(Space.M.dp)) {
        Text(lineName)
        Text("Maximum ${maximum.toMajorString()}")
        Row(horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
          val modes = buildList {
            add(DiscountEntryMode.Amount to "Amount")
            add(DiscountEntryMode.Percentage to "Percent")
            if (allowTarget) add(DiscountEntryMode.Target to "Set subtotal")
          }
          modes.forEach { (entryMode, label) ->
            FilterChip(
              selected = mode == entryMode,
              onClick = { mode = entryMode; amount = "" },
              label = { Text(label) },
            )
          }
        }
        OutlinedTextField(
          value = amount,
          onValueChange = { value -> amount = value.filter { it.isDigit() || it == '.' }.take(12) },
          label = {
            Text(
              when (mode) {
                DiscountEntryMode.Amount -> "Discount amount"
                DiscountEntryMode.Percentage -> "Discount percentage"
                DiscountEntryMode.Target -> "New cart subtotal"
              },
            )
          },
          prefix = { Text(if (mode == DiscountEntryMode.Percentage) "%" else "$") },
          singleLine = true,
          modifier = Modifier.fillMaxWidth(),
        )
        Text("Reason", fontWeight = FontWeight.Medium)
        Row(horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
          listOf("customer_courtesy" to "Courtesy", "damaged_package" to "Damaged").forEach { (code, label) ->
            FilterChip(
              selected = reason == code,
              onClick = { reason = code },
              label = { Text(label) },
            )
          }
        }
      }
    },
    confirmButton = {
      Button(onClick = { onApply(parsed!!, reason) }, enabled = valid) { Text("Apply discount") }
    },
    dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Cancel") } },
  )
}

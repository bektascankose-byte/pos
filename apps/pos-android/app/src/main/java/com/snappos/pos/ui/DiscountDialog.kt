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

@Composable
fun DiscountDialog(
  lineName: String,
  maximum: Money,
  onDismiss: () -> Unit,
  onApply: (Money, String) -> Unit,
) {
  var amount by remember { mutableStateOf("") }
  var reason by remember { mutableStateOf("customer_courtesy") }
  val parsed = runCatching { Money.fromMajor(amount) }.getOrNull()
  val valid = parsed != null && !parsed.isZero && !parsed.isNegative && parsed <= maximum

  AlertDialog(
    onDismissRequest = onDismiss,
    shape = RoundedCornerShape(20.dp),
    title = { Text("Discount item", fontWeight = FontWeight.SemiBold) },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(Space.M.dp)) {
        Text(lineName)
        Text("Maximum ${maximum.toMajorString()}")
        OutlinedTextField(
          value = amount,
          onValueChange = { value -> amount = value.filter { it.isDigit() || it == '.' }.take(12) },
          label = { Text("Discount amount") },
          prefix = { Text("$") },
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

package com.snappos.pos.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
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

/**
 * Change what a line rings up at.
 *
 * A manager PIN authorizes this every time — see `RegisterViewModel`'s
 * `requestPriceOverride`, which never checks the signed-in cashier's own
 * permissions the way the discount dialog does. This dialog only bounds the
 * amount at zero or above; the domain enforces the same thing again on
 * `Cart.overridePrice`, and a name has to be attached before either check
 * matters.
 */
@Composable
fun OverridePriceDialog(
  lineName: String,
  currentPrice: Money,
  onDismiss: () -> Unit,
  onApply: (Money, String) -> Unit,
) {
  var amount by remember { mutableStateOf("") }
  var reason by remember { mutableStateOf("") }
  val parsed = runCatching { Money.fromMajor(amount) }.getOrNull()
  val valid = parsed != null && !parsed.isNegative && reason.isNotBlank()

  AlertDialog(
    onDismissRequest = onDismiss,
    shape = RoundedCornerShape(20.dp),
    title = { Text("Override price", fontWeight = FontWeight.SemiBold) },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(Space.M.dp)) {
        Text(lineName)
        Text("Currently ${currentPrice.toMajorString()}")
        OutlinedTextField(
          value = amount,
          onValueChange = { value -> amount = value.filter { it.isDigit() || it == '.' }.take(12) },
          label = { Text("New price") },
          prefix = { Text("$") },
          singleLine = true,
          modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
          value = reason,
          onValueChange = { reason = it.take(200) },
          label = { Text("Reason (required)") },
          singleLine = true,
          modifier = Modifier.fillMaxWidth(),
        )
      }
    },
    confirmButton = {
      Button(onClick = { onApply(parsed!!, reason.trim()) }, enabled = valid) {
        Text("Request approval")
      }
    },
    dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Cancel") } },
  )
}

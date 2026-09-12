package com.snappos.pos.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.Composable

/** Opens when a cashier taps a cart line: line-level actions stay contextual. */
@Composable
fun LineActionsDialog(
  lineName: String,
  onDismiss: () -> Unit,
  onDiscount: () -> Unit,
  onOverride: () -> Unit,
) {
  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text(lineName) },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(Space.S.dp)) {
        Button(onClick = onDiscount, modifier = Modifier.fillMaxWidth()) { Text("Discount item") }
        OutlinedButton(onClick = onOverride, modifier = Modifier.fillMaxWidth()) {
          Text("Override unit price")
        }
      }
    },
    confirmButton = {},
    dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Close") } },
  )
}

package com.snappos.pos.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun SaleDetailsDialog(
  currentNote: String?,
  currentlyTaxExempt: Boolean,
  onDismiss: () -> Unit,
  onSave: (note: String, taxExempt: Boolean, taxReason: String) -> Unit,
) {
  var note by remember { mutableStateOf(currentNote.orEmpty()) }
  var exempt by remember { mutableStateOf(currentlyTaxExempt) }
  var reason by remember { mutableStateOf("") }
  val requiresReason = exempt && !currentlyTaxExempt

  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text("Sale details") },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(Space.M.dp)) {
        OutlinedTextField(
          value = note,
          onValueChange = { note = it.take(500) },
          label = { Text("Receipt / order note") },
          minLines = 2,
          maxLines = 4,
          modifier = Modifier.fillMaxWidth(),
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
          Checkbox(checked = exempt, onCheckedChange = { exempt = it })
          Text("Tax-exempt sale")
        }
        if (requiresReason) {
          OutlinedTextField(
            value = reason,
            onValueChange = { reason = it.take(256) },
            label = { Text("Exemption reason / certificate reference") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
          )
          Text("A manager PIN is required after saving.")
        }
      }
    },
    confirmButton = {
      Button(
        onClick = { onSave(note, exempt, reason) },
        enabled = !requiresReason || reason.isNotBlank(),
      ) { Text("Save") }
    },
    dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Cancel") } },
  )
}

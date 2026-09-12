package com.snappos.pos.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.snappos.data.entities.HeldCartEntity
import java.text.DateFormat
import java.util.Date

@Composable
fun HoldSaleDialog(onDismiss: () -> Unit, onHold: (String) -> Unit) {
  var label by remember { mutableStateOf("") }
  AlertDialog(
    onDismissRequest = onDismiss,
    shape = RoundedCornerShape(20.dp),
    title = { Text("Hold current sale") },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(Space.S.dp)) {
        Text("Use something the next cashier can recognize, such as a name or description.")
        OutlinedTextField(
          value = label,
          onValueChange = { label = it.take(80) },
          label = { Text("Customer or basket label") },
          singleLine = true,
          modifier = Modifier.fillMaxWidth(),
        )
      }
    },
    confirmButton = {
      Button(onClick = { onHold(label.trim()) }, enabled = label.isNotBlank()) { Text("Hold sale") }
    },
    dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Cancel") } },
  )
}

@Composable
fun HeldSalesDialog(
  held: List<HeldCartEntity>,
  onDismiss: () -> Unit,
  onResume: (String) -> Unit,
) {
  AlertDialog(
    onDismissRequest = onDismiss,
    shape = RoundedCornerShape(20.dp),
    title = { Text("Held sales") },
    text = {
      if (held.isEmpty()) {
        Text("There are no held sales on this register.")
      } else {
        LazyColumn(Modifier.heightIn(max = 360.dp)) {
          items(held, key = { it.id }) { item ->
            Row(
              Modifier.fillMaxWidth().clickable { onResume(item.id) }.padding(vertical = Space.M.dp),
              horizontalArrangement = Arrangement.SpaceBetween,
              verticalAlignment = Alignment.CenterVertically,
            ) {
              Column(Modifier.weight(1f)) {
                Text(item.label, fontWeight = FontWeight.SemiBold)
                Text(
                  DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
                    .format(Date(item.updatedAtMillis)),
                  style = MaterialTheme.typography.labelMedium,
                  color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
              }
              Text("Resume", color = MaterialTheme.colorScheme.primary)
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
          }
        }
      }
    },
    confirmButton = { OutlinedButton(onClick = onDismiss) { Text("Close") } },
  )
}

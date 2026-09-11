package com.snappos.pos.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.snappos.domain.PaperWidth
import com.snappos.domain.ReceiptRenderer
import com.snappos.domain.SaleReceipt
import com.snappos.domain.TextReceipt

/**
 * The receipt, on screen.
 *
 * Rendered through the **same** `TextReceipt` a thermal printer uses, at the
 * same paper width, deliberately. A preview drawn with its own layout would
 * drift from the paper, and the first anyone would know is a customer holding a
 * receipt that does not match the screen they were shown.
 *
 * Monospaced because the rasterizer aligns by counting characters. In a
 * proportional font the amounts stop lining up and the receipt looks broken
 * for a reason nobody can see.
 */
@Composable
fun ReceiptSheet(
  receipt: SaleReceipt,
  onDismiss: () -> Unit,
  width: PaperWidth = PaperWidth.Mm58,
) {
  val lines = TextReceipt.render(ReceiptRenderer.render(receipt), width)

  Dialog(onDismissRequest = onDismiss) {
    Surface(
      shape = RoundedCornerShape(12.dp),
      color = MaterialTheme.colorScheme.surface,
      modifier = Modifier.width(420.dp),
    ) {
      Column(Modifier.padding(Space.M.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
          Text(
            "RECEIPT",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
          )
          Spacer(Modifier.weight(1f))
          Text(
            "${width.columns} col",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }

        Spacer(Modifier.height(Space.S.dp))

        // The paper, as paper: light ground, dark text, fixed pitch.
        Surface(
          color = MaterialTheme.colorScheme.surfaceVariant,
          shape = RoundedCornerShape(4.dp),
          // 240dp, not 420. A phone in landscape has about 384dp of height in
          // total, so a paper area taller than that pushes the Close button off
          // the bottom on any receipt long enough to fill it — and a receipt
          // with a lot of lines is exactly when a cashier wants to read it.
          modifier = Modifier.fillMaxWidth().heightIn(max = 240.dp),
        ) {
          Column(
            Modifier
              .verticalScroll(rememberScrollState())
              .padding(Space.S.dp),
          ) {
            lines.forEach { line ->
              Text(
                // A blank line still needs height, or the receipt loses its
                // spacing the moment it is drawn.
                text = line.ifEmpty { " " },
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
              )
            }
          }
        }

        Spacer(Modifier.height(Space.S.dp))

        Row(
          Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.SpaceBetween,
          verticalAlignment = Alignment.CenterVertically,
        ) {
          // Honest about the hardware. A "Print" button that silently does
          // nothing is worse than no button: a cashier presses it, believes a
          // receipt is coming, and hands the customer nothing.
          Text(
            "No printer configured",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.background(MaterialTheme.colorScheme.surface),
          )
          TextButton(onClick = onDismiss) { Text("Close") }
        }
      }
    }
  }
}

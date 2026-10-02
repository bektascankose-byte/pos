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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.input.KeyboardType
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
  /** Null when there is no printer to send it to; the sheet then says so. */
  onPrint: (() -> Unit)? = null,
  printing: Boolean = false,
  /** What the printer said about itself, or why the last print failed. */
  printNote: String? = null,
  printNoteIsProblem: Boolean = false,
  /** Email or text it. `channel` is "email" or "sms". */
  onSend: ((channel: String, destination: String) -> Unit)? = null,
  sending: Boolean = false,
  /** What became of the last email or text. */
  sendNote: String? = null,
  sendFailed: Boolean = false,
  /** The attached customer's details, so the cashier rarely has to type. */
  customerEmail: String? = null,
  customerPhone: String? = null,
) {
  val lines = TextReceipt.render(ReceiptRenderer.render(receipt), width)

  // Which of Email or Text is open, and what has been typed into it. Null
  // means neither: the sheet opens on the three choices, not on a keyboard.
  var channel by remember { mutableStateOf<String?>(null) }
  var destination by rememberSaveable { mutableStateOf("") }

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

        // Honest about the hardware, and about the wiring. A button that
        // silently does nothing is worse than no button: a cashier presses
        // it, believes the customer has their receipt, and says so. So Print
        // only appears when a printer is actually plugged in, and anything
        // that fails says why here, where the cashier is looking.
        val note = when {
          sending -> "Sending…"
          sendNote != null -> sendNote
          printing -> "Printing…"
          printNote != null -> printNote
          onPrint == null -> "No printer plugged in"
          else -> ""
        }
        val noteIsProblem = when {
          sending || printing -> false
          sendNote != null -> sendFailed
          else -> printNoteIsProblem
        }

        if (note.isNotEmpty()) {
          Text(
            note,
            style = MaterialTheme.typography.bodySmall,
            color = if (noteIsProblem) {
              MaterialTheme.colorScheme.error
            } else {
              MaterialTheme.colorScheme.onSurfaceVariant
            },
            modifier = Modifier.fillMaxWidth().padding(bottom = Space.S.dp),
          )
        }

        // The address line, once a channel is chosen. Shown in place of the
        // choices rather than beside them, because a 420dp dialog on a till
        // has no room for both and the cashier is doing one thing.
        if (channel != null && onSend != null) {
          val isEmail = channel == "email"
          OutlinedTextField(
            value = destination,
            onValueChange = { destination = it },
            singleLine = true,
            label = { Text(if (isEmail) "Email address" else "Mobile number") },
            keyboardOptions = KeyboardOptions(
              keyboardType = if (isEmail) KeyboardType.Email else KeyboardType.Phone,
            ),
            modifier = Modifier.fillMaxWidth(),
          )
          Spacer(Modifier.height(Space.S.dp))
          Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically,
          ) {
            TextButton(onClick = { channel = null }, enabled = !sending) { Text("Back") }
            TextButton(
              onClick = { onSend(channel!!, destination) },
              enabled = !sending && destination.isNotBlank(),
            ) { Text("Send") }
          }
        } else {
          Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically,
          ) {
            if (onPrint != null) {
              TextButton(onClick = onPrint, enabled = !printing && !sending) { Text("Print") }
            }
            if (onSend != null) {
              TextButton(
                onClick = {
                  // Prefilled from the customer on the sale when there is
                  // one, because retyping an address the shop already holds
                  // is how it gets typed wrong.
                  destination = customerEmail.orEmpty()
                  channel = "email"
                },
                enabled = !sending,
              ) { Text("Email") }
              TextButton(
                onClick = {
                  destination = customerPhone.orEmpty()
                  channel = "sms"
                },
                enabled = !sending,
              ) { Text("Text") }
            }
            TextButton(onClick = onDismiss) { Text("Done") }
          }
        }
      }
    }
  }
}

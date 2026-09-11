package com.snappos.pos.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog

/**
 * A manager approving one action.
 *
 * Deliberately does NOT change who is on the register. A refund is approved by
 * a manager standing beside the cashier; signing the cashier out and back in
 * for every one would be both slow and wrong, because the sale that follows
 * still belongs to the cashier.
 *
 * The PIN is checked against every employee who holds the required permission,
 * so an employee with a valid PIN but no authority cannot approve anything.
 */
@Composable
fun ApprovalDialog(
  action: String,
  error: String?,
  onApprove: (String) -> Unit,
  onDismiss: () -> Unit,
) {
  var pin by remember { mutableStateOf("") }

  Dialog(onDismissRequest = onDismiss) {
    Surface(
      shape = RoundedCornerShape(12.dp),
      color = MaterialTheme.colorScheme.surface,
      modifier = Modifier.width(400.dp),
    ) {
      // 16dp rather than 24dp. The reserved message slot above the keypad costs
      // height, and on a phone in landscape the dialog has none to spare: at
      // 24dp the bottom keypad row fell off the screen, taking backspace and
      // clear with it. Losing those means a mistyped digit can only be fixed by
      // submitting it and failing, which locks the employee out that much
      // sooner.
      Column(Modifier.padding(Space.M.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text("Manager approval", style = MaterialTheme.typography.titleLarge)
        Text(
          action,
          style = MaterialTheme.typography.bodyMedium,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(Space.M.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(Space.S.dp)) {
          repeat(maxOf(4, pin.length)) { index ->
            Box(
              Modifier
                .size(16.dp)
                .clip(CircleShape)
                .background(
                  if (index < pin.length) MaterialTheme.colorScheme.primary
                  else MaterialTheme.colorScheme.surfaceVariant,
                ),
            )
          }
        }

        // A fixed slot, whether or not there is anything to say.
        //
        // Two reasons. A refusal that stays on screen while the next PIN is
        // being typed is a verdict on a PIN nobody entered, so it clears on the
        // first digit. And reserving the height means the keypad does not jump
        // under a manager's finger the moment the message appears or goes -
        // which on a register is a mis-tap, and a mis-tapped digit is another
        // failed approval.
        Box(
          Modifier.fillMaxWidth().height(Space.L.dp),
          contentAlignment = Alignment.Center,
        ) {
          if (error != null && pin.isEmpty()) {
            Text(
              error,
              style = MaterialTheme.typography.bodyMedium,
              color = MaterialTheme.colorScheme.error,
            )
          }
        }

        Spacer(Modifier.height(Space.S.dp))
        SimpleKeypad(
          onDigit = {
            if (pin.length < 8) {
              pin += it
              if (pin.length == 4) {
                onApprove(pin)
                pin = ""
              }
            }
          },
          onBackspace = { pin = pin.dropLast(1) },
          onClear = { pin = "" },
        )

        Spacer(Modifier.height(Space.S.dp))
        TextButton(onClick = onDismiss) { Text("Cancel") }
      }
    }
  }
}

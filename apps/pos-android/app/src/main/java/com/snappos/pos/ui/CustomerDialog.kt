package com.snappos.pos.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import com.snappos.sync.CustomerDto

/**
 * Attach a customer to the current sale, or add a new one.
 *
 * Every result here came from the network the moment this dialog asked for
 * it — see `SnapPosApi`'s class doc for why a customer is never held on the
 * device. Search is one field: a phone-shaped entry (digits, optionally a
 * leading `+`) is sent as an exact phone match, anything else as a name/email
 * fragment, so a cashier never has to pick which kind of search they meant.
 *
 * "Add new customer" is always reachable here, the same way a permission
 * gated button elsewhere in the register is never hidden outright —
 * `RegisterViewModel.createCustomer` is the one that actually checks
 * `customer.manage` and reports a refusal, so this dialog does not need to
 * know who is signed in to decide whether to show the option.
 */
@Composable
fun CustomerDialog(
  attached: CustomerDto?,
  results: List<CustomerDto>,
  busy: Boolean,
  error: String?,
  onDismiss: () -> Unit,
  onSearch: (phone: String?, q: String?) -> Unit,
  onClearSearch: () -> Unit,
  onAttach: (CustomerDto) -> Unit,
  onDetach: () -> Unit,
  onCreate: (firstName: String?, lastName: String?, phone: String?, email: String?) -> Unit,
) {
  var query by remember { mutableStateOf("") }
  var addingNew by remember { mutableStateOf(false) }
  var firstName by remember { mutableStateOf("") }
  var lastName by remember { mutableStateOf("") }
  var newPhone by remember { mutableStateOf("") }
  var newEmail by remember { mutableStateOf("") }

  fun submitSearch() {
    val (phone, q) = classifyQuery(query)
    if (phone == null && q == null) return
    onSearch(phone, q)
  }

  val newValid = firstName.isNotBlank() && (newPhone.isNotBlank() || newEmail.isNotBlank())

  AlertDialog(
    onDismissRequest = onDismiss,
    shape = RoundedCornerShape(20.dp),
    title = { Text(if (addingNew) "Add customer" else "Customer") },
    text = {
      // Scrollable: Material3's AlertDialog does not scroll its own content
      // when it overflows, it clips it -- on a short landscape register this
      // form (four fields plus the search results list) is taller than the
      // dialog gets, and everything past the clip point, the "add new" form's
      // own error text included, was silently unreachable. Same failure mode
      // as the compact CartPanel header and SplitPaymentDialog's keypad
      // earlier; same fix.
      Column(
        verticalArrangement = Arrangement.spacedBy(Space.M.dp),
        modifier = Modifier.verticalScroll(rememberScrollState()),
      ) {
        if (attached != null) {
          Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Column {
              Text(attached.displayName, fontWeight = FontWeight.SemiBold)
              (attached.phone ?: attached.email)?.let {
                Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
              }
            }
            TextButton(onClick = onDetach) { Text("Remove") }
          }
          HorizontalDivider(color = MaterialTheme.colorScheme.outline)
        }

        if (!addingNew) {
          OutlinedTextField(
            value = query,
            onValueChange = { query = it; onClearSearch() },
            label = { Text("Phone or name") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { submitSearch() }),
            trailingIcon = {
              IconButton(onClick = { submitSearch() }) { Icon(Icons.Default.Search, "Search") }
            },
            modifier = Modifier.fillMaxWidth(),
          )

          if (busy) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
              CircularProgressIndicator(modifier = Modifier.padding(Space.S.dp))
            }
          }

          error?.let {
            Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
          }

          if (results.isNotEmpty()) {
            LazyColumn(Modifier.heightIn(max = 240.dp)) {
              items(results, key = { it.id }) { customer ->
                Row(
                  Modifier.fillMaxWidth().clickable { onAttach(customer) }.padding(vertical = Space.S.dp),
                ) {
                  Column {
                    Text(customer.displayName)
                    (customer.phone ?: customer.email)?.let {
                      Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                  }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.4f))
              }
            }
          } else if (query.isNotBlank() && !busy && error == null) {
            Text(
              "No match for \"$query\".",
              style = MaterialTheme.typography.labelMedium,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
          }

          TextButton(
            onClick = {
              addingNew = true
              val (phone, q) = classifyQuery(query)
              newPhone = phone ?: ""
              firstName = q ?: ""
            },
          ) { Text("Add new customer") }
        } else {
          OutlinedTextField(
            value = firstName,
            onValueChange = { firstName = it.take(120) },
            label = { Text("First name") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
          )
          OutlinedTextField(
            value = lastName,
            onValueChange = { lastName = it.take(120) },
            label = { Text("Last name") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
          )
          OutlinedTextField(
            value = newPhone,
            onValueChange = { newPhone = it.take(20) },
            label = { Text("Phone") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
          )
          OutlinedTextField(
            value = newEmail,
            onValueChange = { newEmail = it.take(320) },
            label = { Text("Email") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
          )
          Text(
            "A phone or an email is required.",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
          error?.let {
            Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
          }
        }
      }
    },
    confirmButton = {
      if (addingNew) {
        Button(
          onClick = {
            val (phone, _) = classifyQuery(newPhone)
            onCreate(
              firstName.trim().ifEmpty { null },
              lastName.trim().ifEmpty { null },
              (phone ?: newPhone.trim()).ifEmpty { null },
              newEmail.trim().ifEmpty { null },
            )
          },
          enabled = newValid && !busy,
        ) { Text("Save") }
      }
    },
    dismissButton = {
      if (addingNew) {
        OutlinedButton(onClick = { addingNew = false }) { Text("Back") }
      } else {
        OutlinedButton(onClick = onDismiss) { Text("Close") }
      }
    },
  )
}

/**
 * Digits (and an optional leading `+`) are a phone; anything with a letter is
 * a name or email fragment. A bare 10 digit run is assumed US/local and given
 * a `+1`, matching every phone this register's own seed data uses — a
 * cashier types the number as a customer would read it aloud, not E.164.
 */
private fun classifyQuery(input: String): Pair<String?, String?> {
  val trimmed = input.trim()
  if (trimmed.isEmpty()) return null to null
  val digits = trimmed.filter { it.isDigit() }
  val phoneShaped = trimmed.all { it.isDigit() || it == '+' || it == '-' || it == ' ' || it == '(' || it == ')' } &&
    digits.length >= 7
  if (!phoneShaped) return null to trimmed

  val normalized = when {
    trimmed.startsWith("+") && digits.length in 8..15 -> "+$digits"
    digits.length == 10 -> "+1$digits"
    digits.length == 11 && digits.startsWith("1") -> "+$digits"
    else -> null
  }
  return if (normalized != null) normalized to null else null to trimmed
}
